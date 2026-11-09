# M4.5 Operable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Written 2026-11-09 with the spec amendment of the same date (§3, §7.5, §10.3, §15, §17). Not yet
> red-teamed: the disposition table at the end is empty until it is. Items marked `[owner]` wait
> on the owner; `[call]` is the builder's decision, open to the red team.

**Goal:** A person who has never opened Jumpmaster's config file installs it with `docker compose up`, and from then on uses only the browser to connect their Claude and forge credentials, add a repository, get the doctor green, reach a first merged PR, pause or change a zone, rotate a token, add a second repository and recover from a doctor FAIL; and at any moment they can read, in plain language, what Jumpmaster is doing and why it is waiting. Everything they can click, they can also script with `jumpmaster ctl`.

**Architecture:**
- **Auth.** One operator principal with two credentials: a passphrase chosen in the browser on first run (session cookie, CSRF token) and the generated machine token `jumpmaster ctl` already uses (Bearer). Both reach the same control handlers. Pages move behind the login (§7.5). A one-time setup code, printed to the server's stderr at start, claims a fresh install.
- **Config store.** The database holds config revisions; the running system reads the current revision at the top of every pass, so a change applies without a restart. An install is in **file mode** (a config file is present: it is the truth, re-read on reload, shown read-only in the UI) or **db mode** (no file, or the file was adopted: the UI and `ctl` write revisions). Boot settings (`listen`, `dataDir`) come from the file or the environment and are read at start; `mcp.enabled` is the one editable setting that needs a restart, and the UI says so.
- **Vault.** Credentials encrypted at rest (AES-256-GCM) under a key file outside the data volume. File secrets (`*_FILE`) keep working and take precedence. The UI shows source, fingerprint and dates, never a value.
- **Pages.** Server-rendered HTML with small inline scripts, as today: zones (list, add, edit), settings (credentials, install, sticks, history), the setup wizard, a status banner on home, and action links on the doctor page.
- **ctl.** Every control route is in a manifest with its `ctl` verb; a test keeps them equal.

**Tech Stack:** TypeScript (ESM, strict), Node 24+, Fastify 5, better-sqlite3, zod 4, vitest, Biome. No new npm runtime dependency: passphrase hashing is Node's `crypto.scrypt`, the vault is `crypto`'s AES-256-GCM, session and setup codes are `crypto.randomBytes`. No UI framework (§14 leaves it to the builder; the existing pages set the pattern).

**Spec:** `docs/superpowers/specs/2026-10-19-jumpmaster-design.md` §1.3, §3, §4, §7.1, §7.3, §7.5, §8.0, §10.3, §12.1, §13, §15 (M4.5), §17.

## The barrier today, and where each step goes

Scope was chosen by one test: what must a first-time user know, type or edit by hand today, and how does each step go away?

| Today the user must… | After M4.5 | Task |
|---|---|---|
| Read the tokens section of the install runbook and write three or four tokens into `0600` files with a shell helper | Paste each credential into Settings or the setup wizard; it is tested on entry and never shown back | T3, T5, T8 |
| Run `jumpmaster init --repo …` and understand `--preset`, `--identity`, `--author-may-be-admin` | "Add a project" in the browser: detection runs on the server, the gates are shown for review, starter mode is a labelled choice | T4, T8 |
| Hand-edit `config/jumpmaster.config.json` to change a gate, the egress list, crew settings; then restart | The zone page edits each section, validated by path; the change applies at the next pass; history and rollback | T2, T4 |
| Know `claude.tokenCreatedAt` exists and set it | A credential entered in the UI is dated the day it is entered; the expiry banner follows from that | T3, T5 |
| Paste the operator token into a form field for every kill, ruling, doctor run and intake filing | Log in once; the session carries every action | T1 |
| Read a doctor fix hint, then find the config key or the GitHub settings page it means | Each FAIL links to the control that fixes it, in the app or on the forge; missing labels are created with one click | T6 |
| Run `ctl doctor <zone> --drop`, read the stick log for observed hosts, edit `egress.allow`, restart | The Egress section lists what monitor mode observed, with the drops that used each host; tick to adopt | T4 |
| Read slots, queue reasons, outbox and sticks on the home page to work out why nothing is happening | A status line answers "what is Jumpmaster doing and why is it waiting", with the link to act | T7 |
| Add a second repository by editing the file (`init` refuses when a config exists) | "Add a project" again | T4 |
| Watch `docker compose logs stick` to know the runner is alive | Settings → Sticks: last seen, version, capabilities, drain | T5 |
| Script with `docker compose exec jumpmaster jumpmaster ctl …` for a handful of verbs | Unchanged mechanics; every UI action has a verb | T9 |
| Regenerate the operator token file and restart after losing it | `ctl passphrase reset` reopens setup for the passphrase; the token file stays the machine credential | T1 |

**What stays by hand, and why.** `docker compose up`, and reading the setup code from its output; creating the bot accounts and their tokens on GitHub (the doctor links to the pages, the runbook keeps the exact permissions); `claude setup-token` on the operator's own machine (§12.1: Jumpmaster never intermediates a Claude credential); the branch ruleset and CODEOWNERS on GitHub (the doctor links to the ruleset page; writing repository settings is a non-goal of the doctor, M4 ruling); the first `agent-ready` issue, which the intake page already files.

## Global Constraints

- Build on `main` after M4 Tasks 16–17 land: this plan modifies `apps/server/src/init.ts`, `deploy/compose.yaml.tmpl`, `deploy/smoke.sh`, `docs/runbooks/install.md` and `scripts/docs.test.ts` from them. Run `npm test`, `npm run typecheck` and `npx biome check .` before every commit.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, as the owner chose for this repository. PR bodies carry no generated-with footer.
- **Naming.** This repository is public. Call the owner's project "the reference project" and the gate's repositories "the test repositories". No private project names, hostnames, local paths, employer names or logins other than the repository's own. Pages carry the §4 plain-English label beside each term, as the existing pages do.
- **Pinning.** No new dependency is planned. If one becomes necessary, M4's rules apply unchanged (exact npm versions, 40-character action SHAs, digest image refs, 14-day age).
- **Defaults keep every M4 install behaving exactly as it does now.** A config file present at start means file mode: the file is the truth, loaded at start and on `ctl config reload`; the UI shows it read-only until the operator adopts it. File secrets take precedence over the vault. The one visible change for an existing install is the login §7.5 requires: on the first visit the server prints a setup code and the operator chooses a passphrase; `ctl` and the stick are untouched.
- **Migrations** from v18 on, in the order they land: v18 operator, sessions and control audit (T1); v19 config revisions and settings (T2); v20 vault (T3); v21 stick draining and join tokens (T5). Never edit `schema.sql` or an earlier migration. Rollback: an M4 binary runs against all four (added tables and columns are ignored) and reads the config file, so a **db-mode install must `ctl config export` to the file path before a downgrade**; the operate runbook says so (T10).
- Every forge write goes through `runOp` in `outbox.ts`. The one new forge write is label creation (T6), operator-initiated, idempotent by name. The doctor itself still never writes.
- **Secrets.** M4's rule holds (never printed, logged, stored unencrypted, in argv, URLs, layers or forge bodies), and gains: never in a config revision, diff, export, audit row, status line or page. The UI renders a fingerprint (the first 8 hex characters of SHA-256 of the value) and dates. The vault is the only place a value rests in the database, and only as ciphertext. **One bootstrap exception:** the setup code (T1) is printed to stderr at start. It is single-purpose, random (60 bits), invalid once a passphrase exists, and locked after five wrong tries. `SECURITY.md` states it.
- **Two principals, one authorization.** Every `/api/control/*` route accepts the Bearer machine token (`ctl`) or a session cookie with a matching CSRF header (browser). Host and Origin checks stay on every route. Audit rows record `via: 'token' | 'session'`. Credential writes need sudo: a session that re-entered the passphrase within five minutes; the token is always sudo, since whoever holds it holds the secrets directory.
- **Hot apply.** Consumers read `store.current()` at the top of each pass or request and never cache a `Config` across passes. A running drop keeps the payload it was dispatched with. Boot settings (`listen`, `dataDir`) are not in the editable document: they are set in the file or the environment and read at start. `mcp.enabled` is the one editable setting that needs a restart (its route is registered at start), and the UI marks it.
- **ctl parity.** Every UI write has a `ctl` verb, and both reach one handler. T9's manifest test enforces it from T9 on; earlier tasks add their verbs as they add routes.
- Every network-facing or security-relevant task lists its threats under Review Focus. Its tests cover each threat, or the threat is named as resting on the rehearsal.

## Owner steps

These need accounts, people or a decision about the reference project. They are **owner-only**: the implementer stops and asks when the work reaches them.

| When | Owner-only step |
|---|---|
| Before T2 merges | Decide whether the reference project adopts db mode (dogfood) before the design partners, or stays in file mode. The plan assumes **adopt after T8's first dry run**, so the owner meets every surface first `[owner]`. |
| T1 | Confirm the setup code printed to stderr as the one exception to the no-secrets-in-logs rule, or choose the alternative (written to `data/setup-code`, mode `0600`, which costs the user a `cat`) `[owner]`. |
| T6 | Confirm the one-click label creation (a forge write from a doctor link, through the outbox, as the author bot) `[owner]`. |
| Before T11 | Recruit two design partners who have never opened a Jumpmaster config file (at least one not among M4's partners). Provide each with two fresh test repositories with CI, bot accounts and tokens (account creation is not delegated), and a Claude setup-token of their own. |
| T11 | Confirm the gate numbers: two partners, 60 minutes hands-on, zero counts `[owner]`. |
| Each release | Push the version tag. |

## Rulings on spec gaps

- **Two config modes, one-way adopt, export to return `[call]`.** Mixed ownership (some keys from the file, some from the UI) is where every config system becomes unexplainable. An install is in file mode or db mode. Adopt copies the file into revision history and switches the mode; `export` writes the current config back out for whoever wants the file again. A file present in db mode is ignored, loudly (startup log and a doctor note).
- **Passphrase plus machine token `[call]`.** §14 leaves the UI auth mechanism to the builder. A passphrase is what a browser user expects; a generated token is what a script expects. Both are "operator". Neither replaces the other, and `ctl passphrase reset` (token-only) is the recovery path.
- **The setup code goes to stderr `[call; owner]`.** The alternative (a file) adds a shell step to the very flow this milestone exists to remove. The code claims only a fresh install, and a container that can read the compose log is already root-equivalent on the host.
- **File secrets win over the vault `[call]`.** A config-as-code operator who replaces a file expects it to take effect. The UI shows "managed by the file `JM_…_FILE` names" and disables Replace for that credential. The doctor warns when both are set and differ.
- **Boot settings stay outside the editable document `[call]`.** `listen` and `dataDir` are read before the database exists, so they come from the file (file mode) or the environment (db mode) and the UI shows them read-only with where they are set. `mcp.enabled` is editable but its route is registered at start, so a change is accepted, marked "restart pending" and reported by the doctor. Everything else applies live.
- **Zone removal needs a drained observe zone `[call]`.** The guard that already protects the move to observe protects removal. Pause and observe stay runtime state in `drop_zones`, so a config edit never flips a zone's mode.
- **Install-wide forge credentials `[call]`.** One author and one reviewer token serve every zone in M4.5, as today; a fine-grained PAT may list several repositories. Per-zone credentials arrive with M5's second forge.
- **Revisions hold the whole validated document `[call]`.** Zone edits, install settings and adoption are all revisions; rollback is a new revision with old content; history is never deleted. Secrets are not in the document.
- **The doctor stays read-only; label creation is a zone action linked from the check `[call; owner]`.** Missing labels are the most common FAIL on a fresh repository and the fix is mechanical.
- **Egress adoption is per host, ticked by the operator, with the drops that observed it shown `[call]`.** Observation during a hostile drop is a hint, not a truth; nothing is adopted by default.
- **Detection on zone add reuses `init`'s detection `[call]`.** Read-only GETs on the default branch root with the author credential; the result is a proposal the operator confirms. Repository content stays data (§7.1).
- **Sticks: status, drain, remove and a minted join token ship now; the remote stick runbook is M6 `[call]`.** The compose stick keeps pairing by the file join token. Minting costs little and the enrollment route exists.
- **`init` stays; `bootstrap` generates the machine secrets `[call]`.** Compose runs `jumpmaster bootstrap` before the server and the stick, so `docker compose up` alone yields a paired stick and a server waiting for its setup code. `init` remains the scripted install and writes a file (file mode).
- **Session limits `[call]`:** idle 12 hours, absolute 7 days, sudo 5 minutes, login lock 60 seconds after five failures. The cookie is `HttpOnly; SameSite=Strict; Path=/` without `Secure`: the UI is loopback or an SSH tunnel by default, and `config.listen` already warns otherwise.
- **Token age is dated on entry `[call]`.** A credential set in the UI records today as its creation date unless the operator gives one; `claude.tokenCreatedAt` in a file keeps working in file mode.

## Review Focus

1. **Setup takeover (T1, T8).**
   - An unauthenticated `/setup` claimed by someone else, including a container reaching the host's loopback. The setup code is required, random, compared in constant time, single-use, invalid once a passphrase exists, and locked after five wrong tries until restart.
   - The code leaking. It is printed once to stderr, never to a page, cookie, URL or the database; the `jm_setup` cookie proves it was entered and lasts ten minutes.
   - Setup reopened by an attacker. `ctl passphrase reset` needs the Bearer token, never a session.
2. **Sessions and CSRF (T1).**
   - Session fixation or theft. The id is rotated on login, stored hashed, `HttpOnly; SameSite=Strict`, idle and absolute limits, deleted on logout.
   - Cross-site writes. Every non-GET with a session needs the `x-jm-csrf` header equal to the session's token; Host and Origin checks stay in front.
   - Passphrase guessing. scrypt (N=2^15, r=8, p=1, 32-byte salt), minimum 12 characters, five failures lock login for 60 seconds.
   - The machine token weakened. It still works exactly as before and never gets a session.
3. **Secret exposure through the new surfaces (T2, T3, T5).**
   - A value in a revision, diff, export, audit row, page, status line or log. Tests scan each for every secret in the fixture.
   - The vault key on the data volume. It is `JM_VAULT_KEY_FILE` in `secrets/`, like the other secret files; a missing key with a non-empty vault refuses startup.
   - A fingerprint that reveals the value. It is a SHA-256 prefix, never a substring or the length.
   - Replace without proof of presence. Sudo for sessions.
4. **Live-config hazards (T2, T4).**
   - A half-applied change. Revision row and current pointer change in one transaction; the store swaps a whole validated object.
   - A change racing a pass. A pass reads `store.current()` once at its start; a drop keeps its payload.
   - Two editors. `expectRevision` makes every apply conditional; a stale one is a conflict, not an overwrite.
   - A zone removed under running work. Refused unless drained.
   - A restart-only setting reported as live. `RESTART_PATHS` is tested, and a boot setting is never accepted through the editable document.
   - An invalid file on reload. The old config stays; the doctor reports `config.file`.
5. **File and db mode confusion (T2).** A file present in db mode is ignored with a startup log line and a doctor note; `export` before a downgrade is in the runbook; adopt is one-way and audited.
6. **Egress adoption of a hostile host (T4).** Nothing is adopted by default; each host shows the drops that used it and whether a preset lists it; adopted entries pass `validAllowEntry`. The residual (a hostile drop steering the operator's tick) is stated in the operate runbook.
7. **Label creation as a write path (T6).** Through the outbox, as the author bot, idempotent by name, refused when killed, audited, and only the configured label names.
8. **Detection over the author token (T4, T8).** GET-only, default branch root only, result shown for confirmation, no gate runs before the operator saves. Gate commands run credential-less inside drops regardless (§7.2).
9. **A minted join token (T5).** Stored hashed, one use, 24-hour expiry, returned once; the file token keeps working.
10. **DNS rebinding (all).** The Host check stays on pages and routes; the login adds a second wall.

**Gate claims resting on unit tests, not the rehearsal:**
- the setup code's single use, lockout and absence from pages, cookies and the database;
- CSRF refusal, session rotation and expiry;
- the absence of any secret from revisions, diffs, exports, audit rows, pages and logs;
- the conflict on a stale `expectRevision` and the refusal of a half-valid apply;
- the next pass using the new config while a running drop keeps its payload;
- the draining stick receiving no lease;
- the label action's idempotency and its refusal when killed.

The hot-apply claim for a real drop (a changed gate timeout used by the next drop) and the token rotation claim (the next drop carries the new token) rest on the rehearsal as well as on tests.

---

### Task 1: Operator login, sessions, CSRF and setup mode (migration v18)

**Files:**
- Create: `apps/server/src/auth/operator.ts`, `apps/server/src/auth/sessions.ts`, `apps/server/src/auth/guard.ts`, `apps/server/src/auth/audit.ts`, `apps/server/src/ui/auth-pages.ts`
- Modify: `apps/server/src/db/migrations.ts`, `apps/server/src/app.ts`, `apps/server/src/api/control.ts`, `apps/server/src/ui/pages.ts`, `apps/server/src/ctl.ts`, `apps/server/src/main.ts`, `apps/server/src/test/helpers.ts`
- Test: `apps/server/src/auth/operator.test.ts`, `apps/server/src/auth/sessions.test.ts`, `apps/server/src/auth/guard.test.ts`, `apps/server/src/ui/routes.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/ctl.test.ts`, `apps/server/src/db/migrations.test.ts`

**Interfaces:**
- v18 adds `operator(id INTEGER PRIMARY KEY CHECK (id = 1), passphrase_hash TEXT NOT NULL, created_at TEXT NOT NULL, rotated_at TEXT)`; `sessions(id_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, sudo_until TEXT)`; `control_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, via TEXT NOT NULL CHECK (via IN ('token','session','system')), action TEXT NOT NULL, target TEXT, detail_json TEXT NOT NULL)`, keeping the last 5000 rows.
- `hashPassphrase(p: string): string` → `scrypt$N$r$p$<salt b64>$<hash b64>` with N=2^15, r=8, p=1, a 32-byte salt and a 32-byte hash; `verifyPassphrase(p, stored): boolean` in constant time; `MIN_PASSPHRASE = 12`, `MAX_PASSPHRASE = 256`.
- `type SetupState = { codeHash: Buffer; attempts: number; locked: boolean }` held in memory; `newSetupCode(): { code: string; state: SetupState }` with the code as three groups of four base32 characters; `setupActive(db): boolean` is "no operator row".
- `type Principal = { kind: 'operator'; via: 'token' | 'session'; sessionId?: string; sudo: boolean }`; `authenticate(req, deps): Principal | null`: Bearer match → `{ via: 'token', sudo: true }`; else cookie `jm_session` → a live session → `{ via: 'session', sudo: sudo_until > now }`. `requireCsrf(req, principal)`: a session principal on a non-GET needs header `x-jm-csrf` equal to the session's `csrf`.
- `SESSION_IDLE_MS = 12 h`, `SESSION_ABSOLUTE_MS = 7 d`, `SUDO_MS = 5 min`, `LOGIN_LOCK = { failures: 5, windowMs: 60_000, lockMs: 60_000 }`.
- `recordAudit(db, { via, action, target?, detail }, now)` is called by every mutating control handler, with `detail` passed through the secret scrubber first.
- Routes: `GET /login`, `POST /login { passphrase, next? }` (`next` must be a path on this host), `POST /logout`, `GET /setup` (only while `setupActive`, otherwise redirect to `/`), `POST /setup/code { code }` → sets cookie `jm_setup` (ten minutes), `POST /setup/passphrase { passphrase, confirm }` (needs `jm_setup`) → creates the operator and a session, redirects to `/setup/next` (T8 fills the wizard; until then `/`), `POST /api/control/sudo { passphrase }`, `POST /api/control/passphrase/reset` (Bearer only) → deletes the operator row and every session, prints a new setup code.
- Every page route except `/login` and `/setup*` requires a session (redirect to `/login?next=`), after the Host check. Every `/api/control/*` route accepts the token or a session with CSRF. `/api/sticks/*` and `/mcp` are unchanged.
- Pages get `<meta name="jm-csrf" content="…">` and a shared `jmFetch(path, body)` helper that sends the header. The kill, rule, doctor and intake forms lose their "Operator token" fields.
- `main.ts` prints at start, when `setupActive`: `setup: open http://<host>:<port>/setup and enter the setup code XXXX-XXXX-XXXX (valid until this server restarts)`, where host is `127.0.0.1` for a wildcard listen. Five wrong codes print `setup locked: restart the server for a new code`.

- [ ] **Step 1: Write failing tests.**

```ts
test('v18 adds operator, sessions and control_audit, and control_audit keeps the last 5000 rows', ...)
test('with no operator every page redirects to /setup, and /setup accepts only the printed code', ...)
test('a wrong code five times locks setup until restart and logs it', ...)
test('a code accepted once is refused the second time and after a passphrase exists', ...)
test('a passphrase under 12 characters is refused and the stored hash is scrypt with a fresh salt per hash', ...)
test('login sets an HttpOnly SameSite=Strict cookie, rotates the session id and follows next only to a path', ...)
test('a session idle for 12 hours or older than 7 days is refused and deleted', ...)
test('a POST with a valid session but without the matching x-jm-csrf header is 403', ...)
test('a control route accepts the Bearer token without CSRF and a session only with CSRF', ...)
test('a wrong Host or foreign Origin is refused with a valid session and the header', ...)
test('five failed logins within a minute lock login for 60 seconds', ...)
test('sudo lasts five minutes after re-entering the passphrase and the Bearer token is always sudo', ...)
test('every mutating control route writes a control_audit row with its via and no secret value', ...)
test('ctl passphrase reset needs the Bearer token, deletes every session and reopens setup with a new code', ...)
test('the setup code appears once in stderr and never in a page, a cookie, a URL or the database', ...)
test('the kill, rule, doctor and intake forms carry no token field and send the CSRF header', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** `guard.ts` is the one place that decides; `app.ts` registers it as an `onRequest` hook for pages and `control.ts` replaces its token-only hook with it. Keep `tokenMatches` and `originAllowed`.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): add the operator login, sessions, CSRF and setup mode`

### Task 2: The config store: revisions, modes and hot apply (migration v19)

**Files:**
- Create: `apps/server/src/config/store.ts`, `apps/server/src/config/revisions.ts`, `apps/server/src/config/diff.ts`, `apps/server/src/config/boot.ts`
- Modify: `apps/server/src/config.ts`, `apps/server/src/main.ts`, `apps/server/src/app.ts`, `apps/server/src/cli.ts`, `apps/server/src/api/control.ts`, `apps/server/src/ctl.ts`, `apps/server/src/db/migrations.ts`, `apps/server/src/doctor/checks.ts`, `apps/server/src/test/flowHarness.ts`, `apps/server/src/test/helpers.ts`
- Test: `apps/server/src/config/store.test.ts`, `apps/server/src/config/revisions.test.ts`, `apps/server/src/config/diff.test.ts`, `apps/server/src/config.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/ctl.test.ts`, `apps/server/src/cli.test.ts`, `apps/server/src/doctor/checks.test.ts`, `apps/server/src/flow/lifecycle.test.ts`

**Interfaces:**
- v19 adds `config_revisions(id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, config_json TEXT NOT NULL, source_hash TEXT NOT NULL, via TEXT NOT NULL CHECK (via IN ('file','ui','ctl','rollback','adopt','import','setup')), note TEXT, created_at TEXT NOT NULL)` and `settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)` holding `config.mode`, `config.current`, `config.restart_pending`. Revisions are kept in full (kilobytes each).
- `config.ts` splits `FileSchema` into `BootSchema` (`listen`, `dataDir`) and `EditableSchema` (everything else); `parseEditable(json: unknown, opts): { ok: true; config: EditableConfig } | { ok: false; issues: { path: string; message: string }[] }` wraps today's refinements and image resolution. `type Config` stays what consumers see: boot plus editable plus `secrets`.
- `boot.ts`: `loadBoot(env, filePath?): BootConfig`: from the file's `listen` and `dataDir` when a file exists, else `JM_LISTEN_HOST` (default `127.0.0.1`; the server image sets `0.0.0.0`), `JM_LISTEN_PORT` (`7420`), `JM_ALLOWED_HOSTS` (comma list; default loopback on the port), `JM_DATA_DIR` (default `./data`; the image `/data`). Boot settings are not in the editable document: an apply that carries `listen` or `dataDir` is refused at that path with "set in the config file or the environment; restart to change". `RESTART_PATHS = ['mcp.enabled']`.
- `class ConfigStore`: `current(): Config`, `mode(): 'file' | 'db'`, `revision(): number`, `apply(next: unknown, meta: { via; note?; expectRevision?: number }): ApplyResult`, `rollback(id: number, meta): ApplyResult`, `reload(): ApplyResult` (file mode), `adopt(meta): ApplyResult`, `exportJson(): string`, `subscribe(fn: (c: Config, rev: number) => void): () => void`.
  `type ApplyResult = { ok: true; revision: number; changed: string[]; restartNeeded: string[] } | { ok: false; issues: { path: string; message: string }[] } | { ok: false; conflict: { expected: number; actual: number } }`.
- Mode at start: `settings.config.mode` if set; else a file present → `file`, with revision 1 recorded `via: 'file'` when the hash is new; else `db` with revision 1 = defaults and no zones, `via: 'setup'`.
- File mode: `apply` via ui or ctl is refused with one issue at path `''`: "config is managed by the file at <path>: edit it and run `jumpmaster ctl config reload`, or adopt it into the UI". `reload` validates the file; invalid → the old config stays, `config.file` doctor fail with the issues; valid and changed → a new revision. `adopt` records `via: 'adopt'` and sets db mode; a file still present afterwards logs `config file ignored: adopted on <date>` at start and the doctor notes it.
- Hot apply: `main.ts` holds the store; `guardedPass` and the credits and lease passes read `store.current()` once at their start; the forge pairs become `forgePairs.for(zone, secrets)`, cached by `(zone.id, credentialFingerprint)`; `createApp` takes the store and reads per request; `subscribe` runs `ensureZoneMode` for new zones. A changed `RESTART_PATHS` entry is accepted, listed in `restartNeeded`, and sets `config.restart_pending` until the next start; in file mode, `reload` does the same for a changed boot setting in the file.
- `diff(a, b): Change[]` with `type Change = { path: string; from: unknown; to: unknown }`; `dropZones` are matched by `id`, other arrays by index.
- Zone removal is refused unless the zone is in observe with no active drop or pending outbox op (the guard the mode change already uses, extracted as `zoneDrained(db, zoneId)`).
- Routes: `GET /api/control/config` → `{ mode, revision, config, boot, restartPending, filePath? }`; `PUT /api/control/config { config, expectRevision, note? }`; `PATCH /api/control/config { patch, expectRevision, note? }` (RFC 7396 merge patch on the editable document); `GET /api/control/config/revisions?limit=` → `[{ id, parentId, createdAt, via, note, changes }]`; `POST /api/control/config/rollback { id, note? }`; `POST /api/control/config/reload`; `POST /api/control/config/adopt`; `GET /api/control/config/export`; `POST /api/control/config/import { config, dryRun? }` → the diff, applied unless `dryRun`.
- `ctl config show [--json] | revisions | diff <a> <b> | set <path>=<json>… | rollback <id> [note] | import <file> [--dry-run] | export [file] | reload | adopt`.
- `jumpmaster serve [config]`: the path is optional; `JM_CONFIG` names it in the image; absent or missing file → db mode.

- [ ] **Step 1: Write failing tests.**

```ts
test('v19 adds config_revisions and settings', ...)
test('a server started with a file is in file mode and records revision 1 via file', ...)
test('a server started without a file is in db mode with defaults, no zones and revision 1 via setup', ...)
test('in file mode a UI or ctl apply is refused with the reload-or-adopt message and nothing changes', ...)
test('reload records a revision only when the file hash changed and keeps the old config when the new file is invalid', ...)
test('adopt switches to db mode and records via adopt, and a later reload is a no-op the doctor reports', ...)
test('apply validates with the editable schema and returns issues by path, applying nothing on failure', ...)
test('apply with a stale expectRevision returns a conflict and changes nothing', ...)
test('apply is atomic: the revision row and config.current change together or not at all', ...)
test('the next scheduler pass dispatches with the new config while a running drop keeps its payload', ...)
test('a changed author token fingerprint rebuilds the forge pair and an unchanged one keeps it', ...)
test('a new zone gets its mode row on apply and removing a zone with active work is refused', ...)
test('a change to mcp.enabled is accepted, listed in restartNeeded and sets restart_pending', ...)
test('an apply that carries listen or dataDir is refused at that path, and the boot values come from the file or the environment', ...)
test('diff matches zones by id and contains no secret value', ...)
test('rollback creates a new revision with the old content and never deletes history', ...)
test('export equals the current config with boot settings and without secrets, and re-imports unchanged', ...)
test('ctl config set applies a merge patch and ctl config import --dry-run prints the diff without applying', ...)
test('jumpmaster serve without a path starts in db mode from JM_DATA_DIR', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Start with `parseEditable` and the store over an in-memory database; then move each consumer in `main.ts` to `store.current()`, one pass at a time, running the flow harness after each.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): hold config in revisions and apply changes without a restart`

### Task 3: The vault and credential rotation (migration v20)

**Files:**
- Create: `apps/server/src/vault/vault.ts`, `apps/server/src/vault/credentials.ts`
- Modify: `apps/server/src/config.ts`, `apps/server/src/config/store.ts`, `apps/server/src/main.ts`, `apps/server/src/api/control.ts`, `apps/server/src/ctl.ts`, `apps/server/src/doctor/checks.ts`, `apps/server/src/db/migrations.ts`, `apps/server/src/init.ts`, `apps/server/src/payloads.ts`, `deploy/compose.yaml.tmpl`
- Test: `apps/server/src/vault/vault.test.ts`, `apps/server/src/vault/credentials.test.ts`, `apps/server/src/config.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/ctl.test.ts`, `apps/server/src/doctor/checks.test.ts`, `apps/server/src/init.test.ts`, `deploy/deploy.test.ts`

**Interfaces:**
- v20 adds `vault(name TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, key_id TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, declared_created_at TEXT, tested_at TEXT, test_result TEXT, note TEXT)`.
- `type CredentialName = 'claudeToken' | 'githubAuthorToken' | 'githubReviewerToken' | 'githubReadToken' | \`zone:${string}:${string}\`` (the last for gate secrets, today's `JM_ZONE_<ID>_<NAME>`).
- `openVault(keyFile: string | undefined, db): Vault | 'disabled'`: key is 32 bytes from `JM_VAULT_KEY_FILE` (written by `bootstrap` and `init`, mode `0600`, outside the data volume); `keyId = sha256(key).hex.slice(0, 8)`; AES-256-GCM with a 12-byte nonce per write and the name as AAD. No key file with a non-empty vault refuses startup: "the vault at <dataDir> holds N credentials but JM_VAULT_KEY_FILE is unset: the key and the data travel together". No key file with an empty vault → `'disabled'`: the UI's Replace is disabled with "set JM_VAULT_KEY_FILE". A key that fails to decrypt → doctor `vault.key` fail: "the vault key changed: restore the key file or re-enter each credential".
- `type Resolved = Record<CredentialName, { value?: string; source: 'file' | 'env' | 'vault' | 'missing'; fingerprint?: string; setAt?: string; declaredCreatedAt?: string; testedAt?: string; testResult?: string }>`; `resolveCredentials(env, vault): Resolved`, file or env first, vault second. The store assembles `config.secrets` from it; `secretList` and `payloadSecrets` include vault values; `credentialFingerprint(resolved)` feeds T2's pair cache.
- `fingerprintOf(value) = sha256(value).hex.slice(0, 8)`.
- Tests on entry: `githubAuthorToken` and `githubReviewerToken` → `viewerLogin` plus `repoAccess` for every zone (and the reviewer login must differ from the author's in two-bot zones); `githubReadToken` → `viewerLogin`; `claudeToken` → shape only, with "the doctor drop is the live proof"; a gate secret → length and name rules only. A failed test stores nothing and returns what it saw (the login, or the 403 and its permission).
- Routes: `GET /api/control/secrets` → the list without values; `PUT /api/control/secrets/:name { value, declaredCreatedAt?, note? }` (sudo for sessions; value ≤ 64 KiB, no newline); `POST /api/control/secrets/:name/test`; `DELETE /api/control/secrets/:name` (vault entries only; refused for a credential a zone needs); `POST /api/control/secrets/reload` (re-reads file and env credentials).
- `ctl secrets list | set <name> [--from-file <path>] [--created YYYY-MM-DD] | test <name> | remove <name> | reload`; `set` reads the value from `--from-file` or stdin, never argv.
- `credentialCreatedAt('claudeToken')`: the vault's `declared_created_at` (defaulting to `created_at`) in db mode, `claude.tokenCreatedAt` in file mode; `claude.token-age` uses it. New doctor checks: `credential.missing` (fail per required credential that resolves to `missing`), `credential.shadowed` (warn: file and vault both set and different; the file is in use), `vault.key`.
- Compose passes `JM_VAULT_KEY_FILE: /run/secrets/vault_key`; `init` writes `secrets/vault_key` beside the join and operator tokens.

- [ ] **Step 1: Write failing tests.**

```ts
test('v20 adds vault', ...)
test('a value round-trips through AES-256-GCM with the name as AAD and a fresh nonce per write', ...)
test('a wrong key fails to decrypt and the doctor reports vault.key as fail, naming no value', ...)
test('a missing key file with a non-empty vault refuses startup with the travel-together message', ...)
test('a file or env credential wins over a vault entry and the list shows source file with Replace disabled', ...)
test('a credential set in both places with different values warns credential.shadowed without printing either', ...)
test('PUT secrets needs sudo for a session and never for the Bearer token', ...)
test('a rotated author token is tested against every zone, the next drop payload carries it and a running drop keeps the old', ...)
test('a reviewer token with the author login is refused in a two-bot install', ...)
test('a failed test stores nothing and reports the login or the 403 and its permission', ...)
test('the list carries fingerprint, source and dates and no value, prefix, suffix or length', ...)
test('a Claude token set in the UI dates claude.token-age from today unless a date is given', ...)
test('a required credential that resolves to missing fails credential.missing, naming the credential and no value', ...)
test('ctl secrets set reads the value from stdin or a file and refuses one in argv', ...)
test('vault values are scrubbed from server logs and from payload redaction', ...)
test('init writes secrets/vault_key with mode 0600 and the compose template passes JM_VAULT_KEY_FILE', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** The vault module knows nothing about credentials; `credentials.ts` knows the names, sources and tests.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): add the credential vault and rotation from the control API`

### Task 4: The zones page and `ctl zones`

**Files:**
- Create: `apps/server/src/ui/zones.ts`, `apps/server/src/zones/detect.ts`, `apps/server/src/zones/form.ts`
- Modify: `apps/server/src/init.ts` (detection moves to `zones/detect.ts`), `apps/server/src/api/control.ts`, `apps/server/src/app.ts`, `apps/server/src/ctl.ts`, `apps/server/src/ui/pages.ts`, `apps/server/src/doctor/checks.ts` (`egressSeen` and `HostSeen` exported)
- Test: `apps/server/src/ui/zones.test.ts`, `apps/server/src/zones/detect.test.ts`, `apps/server/src/zones/form.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/ctl.test.ts`, `apps/server/src/ui/routes.test.ts`, `apps/server/src/init.test.ts`

**Interfaces:**
- Pages: `GET /zones` (one row per zone: id, repo, mode with its plain label, preset or image, egress mode, identity, last drop, the doctor's fail count; Pause, Resume, Observe buttons; "Add a project"), `GET /zones/new`, `GET /zones/:id`.
- The zone page has sections, each a form that posts one merge patch (`PATCH /api/control/config` with `{ dropZones: [{ id, …}] }`) and `expectRevision`: **Project** (repo, `readyLabel`, `retryLabel`, `adoptPulls`), **Stack** (preset or image digest, gates as rows of name, run, timeout, verification, services, limits), **Egress** (mode; allow list; **Observed in the last 14 days**: host, the drops that used it, whether a preset lists it, a tick box per host, "Adopt ticked"), **Merging** (identity with `STARTER_WARNING` verbatim, `ciRequired`, `ciDeadlineMinutes`, `requireBranchProtection`, `authorMayBeAdmin`, `protectedPaths`, `overrideApprovers`, `reviewReadToken`), **Models** (`model`, `models` per role, `maxTurns`, `maxConcurrentImplement`), **Budgets** (today's six), **Crew** (the `CrewSchema` fields), **Gate secrets** (names only; values are set in Settings), **Advanced** (the zone's JSON, editable, validated the same way). Schema issues render beside the field whose path they name. File mode renders every section read-only under the adopt banner.
- `formToZone(fields: Record<string, string | string[]>): unknown` and `zoneToForm(zone: DropZoneConfig): Record<string, string | string[]>`, pure, with a round-trip property over every zone in the test fixtures.
- `detect.ts`: `detectRepo(forge, repo): Promise<Detection>` with `type Detection = { visibility: 'public' | 'private'; defaultBranch: string; preset?: Preset; candidates: Preset[]; gates: GateSpec[] }`, GET-only on the default branch root, shared with `init`.
- Routes: `POST /api/control/detect { repo }`; `POST /api/control/zones { zone }` (id defaults to the repository name in lower case; a repo already in another zone is refused); `DELETE /api/control/zones/:id` (T2's `zoneDrained`); `GET /api/control/zones/:id/egress/observed` → `{ since, hosts: HostSeen[] }` from `egressSeen(db, zoneId, since)`; `POST /api/control/zones/:id/egress/adopt { hosts }` → entries validated by `validAllowEntry`, added to `egress.allow`, revision note "adopt observed hosts: …". The existing `POST /api/control/zones/:id { mode }` stays.
- `ctl zones list [--json] | show <zone> [--json] | add <owner/name> [--id <id>] [--preset <p>] [--identity starter] [--egress off|monitor|enforce] | set <zone> <path>=<json>… | remove <zone> | egress observed <zone> | egress adopt <zone> <host>…`; `ctl detect <owner/name>`.

- [ ] **Step 1: Write failing tests.**

```ts
test('/zones lists every zone with its plain-English mode, egress mode and identity, and links its page', ...)
test('each section of the zone page is filled from the current config and posts a patch with expectRevision', ...)
test('a schema issue is rendered beside the field its path names', ...)
test('form fields and zone JSON round-trip for every fixture zone', ...)
test('in file mode the zone page is read-only and shows the adopt banner', ...)
test('detect makes only GET calls to the default branch root and proposes gates the operator must confirm', ...)
test('init uses the shared detection and its output is unchanged', ...)
test('adding a zone whose repo is already in another zone is refused', ...)
test('the egress section lists observed hosts with their drops and marks those no preset lists', ...)
test('adopt adds only ticked, valid entries and records the revision note', ...)
test('removing a zone with active work is refused and a drained observe zone is removed with its mode row', ...)
test('pause, resume and observe from the zones page keep the existing guards', ...)
test('the zone page shows no secret and the gate-secret section lists names only', ...)
test('ctl zones add, set, remove and egress adopt map to the routes and refuse an unknown path', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** `form.ts` first (pure), then the pages, then the routes and `ctl`.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): add the zones page and ctl zones`

### Task 5: Settings: credentials, install settings and sticks (migration v21)

**Files:**
- Create: `apps/server/src/ui/settings.ts`
- Modify: `apps/server/src/api/control.ts`, `apps/server/src/api/sticks.ts`, `apps/server/src/db/repo.ts`, `apps/server/src/db/migrations.ts`, `apps/server/src/app.ts`, `apps/server/src/ctl.ts`, `apps/server/src/ui/pages.ts`, `apps/server/src/doctor/checks.ts`
- Test: `apps/server/src/ui/settings.test.ts`, `apps/server/src/api/sticks.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/db/repo.test.ts`, `apps/server/src/ctl.test.ts`, `apps/server/src/doctor/checks.test.ts`

**Interfaces:**
- v21 adds `sticks.draining_at TEXT`, `sticks.revoked_at TEXT` and `join_tokens(id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_by_stick_id TEXT)`.
- `GET /settings` with five tabs. **Credentials:** a row per `CredentialName` in use (name, plain-English role, source, fingerprint, set at, created at — editable for the Claude token — last test and result), Replace (opens the sudo prompt for a session, then a `PUT` with the value in the body only) and Test; a banner when the Claude token is past day 330, repeated on home. **Install:** `pollSeconds`, `usage.throttleUtilization`, `usage.stopOnOverage`, `claude.plan`, `claude.fableModel`, `claude.fableWeeklyDropCap`, `requireSignedImages`, `mcp.*` (with `mcp.enabled` marked "takes effect at the next restart"); `listen` and `dataDir` shown read-only with where they are set (the file, or `JM_LISTEN_HOST`, `JM_LISTEN_PORT`, `JM_ALLOWED_HOSTS`, `JM_DATA_DIR`); a "restart pending" badge from `config.restart_pending`. **MCP tokens** (§7.5: Command's tokens are created in the UI with a scope and an expiry; the routes exist since M3, the page and the `ctl` verbs don't): mint with zone, scope and days (shown once), list, revoke. **Sticks:** a row per stick (name, version, last seen, slots, capabilities, image policy, pins, draining since), Drain, Undrain, Remove (refused with an active drop), and "Pair another stick" (mints a join token shown once with a compose snippet; 24-hour expiry; one use). **History:** T2's revisions with their changes and a Revert button per revision.
- Lease: a draining or revoked stick gets `{ none: true, reason: 'draining' | 'revoked' }` from `/api/sticks/lease`; heartbeats, events and results from a draining stick are accepted; a revoked stick gets 401 everywhere.
- Enroll: `joinToken` matches the file token or an unused, unexpired `join_tokens` row by hash; a used row records `used_at` and `used_by_stick_id`.
- Routes: `GET /api/control/sticks`; `POST /api/control/sticks/:id/drain`; `POST /api/control/sticks/:id/undrain`; `DELETE /api/control/sticks/:id`; `POST /api/control/join-tokens { label?, hours? }` → `{ token, expiresAt }` once; `GET /api/control/join-tokens` (hashes never returned).
- Doctor: `stick.draining` warn when no non-draining stick can serve a zone; `claude.token-age`'s banner condition exported as `tokenExpiryWarning(resolved, now)`.
- `ctl sticks list [--json] | drain <id> | undrain <id> | remove <id> | join-token [--hours N] [--label <text>]`; `ctl settings set <path>=<json>…` (T2's `config set`, limited to install-wide paths); `ctl mcp-tokens mint <zone> <read|write> --days N [--label <text>] | list | revoke <id>` over the existing routes.

- [ ] **Step 1: Write failing tests.**

```ts
test('v21 adds draining_at, revoked_at and join_tokens', ...)
test('the credentials tab shows source, fingerprint and dates for each credential and no value', ...)
test('Replace opens a sudo prompt for a session and the PUT carries the value only in the body', ...)
test('a Claude token past day 330 shows the expiry banner on settings and on home', ...)
test('the install tab marks listen, dataDir and mcp.enabled as restart-needed and applies the rest live', ...)
test('a draining stick gets no lease, keeps heartbeating and reporting, and undrain restores it', ...)
test('removing a stick with an active drop is refused, and a removed stick is 401 on every stick route', ...)
test('a minted join token enrolls one stick once and then expires, while the file token still works', ...)
test('the join token is returned once and stored only as a hash', ...)
test('history lists revisions with their changes and Revert posts a rollback with the id', ...)
test('stick.draining warns when only draining sticks could serve a zone', ...)
test('the MCP tokens tab mints a token shown once, lists tokens without values and revokes one', ...)
test('ctl sticks, ctl settings set and ctl mcp-tokens map to the routes', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): add the settings page with credentials, install settings and sticks`

### Task 6: Doctor: fix links and the label action

**Files:**
- Create: `apps/server/src/doctor/actions.ts`
- Modify: `apps/server/src/doctor/checks.ts`, `apps/server/src/doctor/run.ts`, `apps/server/src/ui/pages.ts`, `apps/server/src/api/control.ts`, `apps/server/src/ctl.ts`, `apps/server/src/outbox.ts`, `apps/server/src/forge/github.ts`
- Test: `apps/server/src/doctor/actions.test.ts`, `apps/server/src/doctor/checks.test.ts`, `apps/server/src/ui/routes.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/outbox.test.ts`, `apps/server/src/forge/github.test.ts`

**Interfaces:**
- `DoctorCheck.action?: { kind: 'app' | 'forge' | 'docs'; label: string; href: string }`. `app` is a path in this UI; `forge` is a page on the repository (`https://github.com/<owner>/<name>/settings/rules`, `/settings/access`, `/labels`); `docs` is today's install-runbook anchor. `fix` stays for `ctl` and the page.
- `actionFor(check: DoctorCheck, ctx: { zone?: DropZoneConfig }): Action | undefined` from a table keyed by check id, plus `NO_ACTION: Record<string, string>` naming each id without an action and why. The mapping: `config.listen`, `claude.plan`, `usage.gate` → `/settings#install`; `config.uid` → docs; `claude.token-age`, `forge.author`, `forge.reviewer`, `forge.author-reads`, `forge.reviewer-reads`, `forge.admin`, `forge.private-clone`, `credential.*`, `vault.key` → `/settings#credentials`; `control.kill` → `/`; `stick.*` → `/settings#sticks`; `forge.branch-rules`, `forge.codeowners`, `forge.ci` → the forge rules page; `forge.labels` → the app action **Create the missing labels**; `zone.mode` → `/zones`; `zone.preset`, `zone.services`, `zone.egress`, `zone.identity`, `zone.goals`, `zone.crew-cap` → `/zones/<id>#<section>`; `zone.doctor-drop` → the existing run button; `config.restart-pending` → docs; `config.file` → `/settings#history`.
- `POST /api/control/zones/:id/labels` → outbox op `create-labels` (for each configured label missing: GET, then create as the author bot; idempotent by name), refused while killed, audited, then re-runs `forge.labels`. `GitHubForge.createLabel(name, color, description)`.
- The doctor page renders fails first, each with its action as a link or button; `ctl doctor` prints an `action:` line per fail (the href, or the route for an app action).

- [ ] **Step 1: Write failing tests.**

```ts
test('every doctor check id has an action or a reason in NO_ACTION, and the install runbook lists the same ids', ...)
test('a zone check links to its zone page section and a credential check to settings', ...)
test('forge.labels offers the create action, which runs through the outbox as the author and is idempotent', ...)
test('the label action is refused while killed and writes an audit row', ...)
test('the doctor page renders fails first with their action links escaped', ...)
test('ctl doctor prints the action for each fail', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): link each doctor fail to the control that fixes it`

### Task 7: Status: what Jumpmaster is doing and why it waits

**Files:**
- Create: `apps/server/src/status.ts`
- Modify: `apps/server/src/ui/pages.ts`, `apps/server/src/app.ts`, `apps/server/src/api/control.ts`, `apps/server/src/ctl.ts`
- Test: `apps/server/src/status.test.ts`, `apps/server/src/ui/routes.test.ts`, `apps/server/src/ctl.test.ts`

**Interfaces:**
- `type Status = { headline: string; detail: string; waitingOn: 'nothing' | 'you' | 'ci' | 'forge' | 'claude' | 'stick' | 'setup' | 'doctor'; since?: string; action?: { label: string; href: string } }`.
- `type StatusInput = { setupActive: boolean; killed: boolean; usagePausedUntil?: string; sticks: { live: number; draining: number }; doctorFails: DoctorCheck[]; openBriefings: number; zones: { id: string; mode: ZoneMode; items: WorkItem[]; drops: Drop[]; parked: number }[]; outboxRetrying: OutboxRow[]; restartPending: boolean }`, built in `app.ts` from what the home route already loads plus `latestDoctorRun`.
- `statusOf(input: StatusInput, now: Date): Status`, pure; first match wins: setup incomplete ("Finish setup", `/setup`); killed ("Stopped by the kill switch since …", `/`); usage pause ("Paused by Claude's usage limit until …"); no live stick ("No runner: the stick hasn't checked in", `/settings#sticks`); doctor fails ("Blocked: N doctor fails, first <id>", `/doctor`); open briefings ("Waiting on you: N briefings", `/briefings`); every zone paused or observing ("Paused by you: <zones>", `/zones`); a running drop ("Working: <role> #<issue> in <zone>, <elapsed>, gate <k> of <n>", `/drops/<id>`); waiting on CI ("Waiting on CI for PR #<n> (<m> of <deadline> min)"); an outbox op retrying ("Retrying a GitHub call: <op>", `/`); parked items ("N parked: <first reason>", `/`); queued without a slot ("Queued: N issues; every slot is busy"); idle ("Idle: no ready issues. Label one agent-ready or file one from Intake", `/zones/<id>/intake`). `restartPending` appends "A restart is pending for <paths>" to `detail`.
- The home page opens with the status banner; the page `<title>` carries the headline. `GET /api/control/status` → `Status`; `ctl status [--json]`.

- [ ] **Step 1: Write failing tests.**

```ts
test('statusOf returns one headline per state, in priority order, over the fixture table', ...)
test('the home page opens with the status banner and its action link, and titles the page with the headline', ...)
test('ctl status prints the headline and detail, and --json the object', ...)
test('the status names zones, issues and PRs and never a token', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): say what Jumpmaster is doing and why it waits`

### Task 8: First run in the browser: `bootstrap`, the setup wizard and optional `init`

**Files:**
- Create: `apps/server/src/bootstrap.ts`, `apps/server/src/ui/setup.ts`
- Modify: `apps/server/src/cli.ts`, `apps/server/src/init.ts`, `apps/server/src/app.ts`, `apps/server/src/auth/guard.ts`, `apps/server/src/ui/auth-pages.ts`, `deploy/compose.yaml.tmpl`, `deploy/compose.build.yaml`, `deploy/smoke.sh`, `scripts/render-compose.ts`
- Test: `apps/server/src/bootstrap.test.ts`, `apps/server/src/ui/setup.test.ts`, `apps/server/src/cli.test.ts`, `apps/server/src/init.test.ts`, `deploy/deploy.test.ts`, `scripts/render-compose.test.ts`

**Interfaces:**
- `jumpmaster bootstrap [dir]`: creates `secrets/join_token`, `secrets/operator_token` and `secrets/vault_key` (32 random bytes each, base64url, mode `0600`) when missing; idempotent; refuses uid 0 as `init` does; prints the names it created and never a value; exit 0. `init` gains `--secrets-only` (the same) and calls `bootstrap` for its secrets.
- Compose: a `bootstrap` service (the server image, `command: bootstrap`, `restart: "no"`, mounting `./secrets`); `jumpmaster` and `stick` gain `depends_on: bootstrap: condition: service_completed_successfully`; the server's command is `serve` with `JM_CONFIG=/config/jumpmaster.config.json`, so a file written by `init` means file mode and no file means db mode; the `init` profile stays.
- The wizard after T1's passphrase step, each step a thin frame over an existing handler, with "Do this later" on every step and progress in `settings.setup_step`: `/setup/claude` (token and plan; where to get it: `claude setup-token`; the link to Anthropic's terms, §12.1), `/setup/forge` (author token; reviewer token or starter mode with `STARTER_WARNING` verbatim; read token for a private repository; each tested before saving), `/setup/stick` ("Your runner has checked in" from `sticks.last_seen_at`, or the `docker compose logs stick` hint), `/setup/project` (repository → `detect` → gates for review → create, egress monitor, identity as chosen), `/setup/doctor` (runs it; fails with their actions; "Go to the factory floor"). The frame shows until a zone exists or the operator dismisses it; every control it offers lives in Settings or Zones afterwards. A file-mode install sees "Your config file holds N zones" with the adopt offer in place of the project step.
- `deploy/smoke.sh` runs twice: with no config file (db mode: bootstrap, setup code from the log, passphrase and a zone through the API) and with an `init`-written one (file mode, unchanged).

- [ ] **Step 1: Write failing tests.**

```ts
test('bootstrap creates the three machine secrets with mode 0600 once, is idempotent and prints no value', ...)
test('the compose template runs bootstrap before the server and the stick and keeps the init profile', ...)
test('a fresh install redirects to /setup, and each wizard step is skippable and resumable', ...)
test('the forge step tests the token before saving and shows the starter warning verbatim', ...)
test('the project step runs detection and creates the zone through the same apply path as the zones page', ...)
test('the wizard disappears once a zone exists or is dismissed, and Settings holds every control it had', ...)
test('a file-mode install sees its zones in the wizard with the adopt offer', ...)
test('init --secrets-only equals bootstrap and init still writes a file-mode install', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and the smoke script in both modes.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: set up a fresh install from the browser`

### Task 9: `ctl` parity and the control manifest

**Files:**
- Create: `apps/server/src/api/manifest.ts`
- Modify: `apps/server/src/api/control.ts`, `apps/server/src/ctl.ts`
- Test: `apps/server/src/api/manifest.test.ts`, `apps/server/src/ctl.test.ts`

**Interfaces:**
- `CONTROL_ROUTES: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; ctl: string | null; reason?: string }[]`, one entry per route under `/api/control/`, `ctl` an example invocation that `ctlRequest` (today's parser in `ctl.ts`) must map to that method and path; `ctl: null` only with a `reason` (`/api/control/sudo`: "browser re-auth; the token is always sudo").
- `ctl help` prints every verb grouped by page (Status, Zones, Settings, Credentials, Sticks, Config, Doctor, Briefings, Kill); `ctl <verb> --help` prints that verb's forms. The `usage:` string in `ctl.ts` is generated from the manifest.

- [ ] **Step 1: Write failing tests.**

```ts
test('every registered /api/control route is in the manifest and every manifest entry is registered', ...)
test('every manifest entry with a ctl example parses to its method and path', ...)
test('a manifest entry without a ctl verb carries a reason', ...)
test('ctl help lists every verb in the manifest and nothing else', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): keep ctl and the control API in step with a manifest`

### Task 10: Docs: the browser path first

**Files:**
- Create: `docs/runbooks/operate.md`
- Modify: `README.md`, `docs/runbooks/install.md`, `SECURITY.md`, `examples/jumpmaster.config.json`, `scripts/docs.test.ts`
- Test: `scripts/docs.test.ts`

**Interfaces:**
- README quickstart: `docker compose up`, open `http://127.0.0.1:7420`, enter the setup code from the output; the scripted path (`init`) moves to the install runbook.
- `install.md`: the browser path first (bootstrap, setup code, wizard, doctor), then the scripted install (`init`, file mode), then "Config as code" (file mode, `reload`, `adopt`, `export`), then the existing reference sections; the troubleshooting-by-check-id section gains each check's action.
- `operate.md`: zones (add, edit, pause, observe, remove, egress adoption and its residual), settings (credentials, rotation, token age, install settings, sticks, join tokens, history and rollback), status, the doctor's actions, the `ctl` table generated from the manifest, downgrade ("export before you downgrade"), and **the operability session** (T11's script, so a partner can be handed one page).
- `SECURITY.md`: sessions, CSRF, the vault and its key, the setup code exception.
- `docs.test.ts` gains: every `ctl` verb in the manifest appears in `operate.md`; every `docs` action anchor exists; the setup-code exception is stated in `SECURITY.md`; the public docs still name no personal path.

- [ ] **Step 1: Write the failing docs tests.**
- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Write the docs.**
- [ ] **Step 4: Run `npx vitest run scripts`.** Expected: PASS.
- [ ] **Step 5: Commit.** `docs: put the browser path first and add the operate runbook`

### Task 11: Gate rehearsal: the operability session

**Files:**
- Create: `docs/runbooks/m4-5-gate.md`

- [ ] **Step 1: Write the gate runbook.**
  - **Setup the operator provides** (the only inputs): a machine with Docker and an empty directory; two fresh test repositories with small seed apps and CI; bot accounts and their tokens as fine-grained PATs (owner step); the partner's own Claude setup-token; the public repository URL.
  - **The partner:** a person who has never opened a Jumpmaster config file. They get one page: the operate runbook's operability session. The author is present to inject the FAIL and to time, and says nothing else.
  - **The session**, in order, each with its measure:
    1. `docker compose up`; open the URL; enter the setup code; choose a passphrase. *Measure:* time to the setup page.
    2. Connect the Claude token and the forge tokens in the wizard; add the first repository; run the doctor. *Measure:* time to a green doctor; every fail seen and whether its link was followed.
    3. File the first issue from Intake; wait for the PR to merge. *Measure:* time to merge (excluded from hands-on time).
    4. Pause the zone; change a gate timeout; resume. *Assert:* the next drop runs with the new timeout, with no restart (the stick log shows the payload's value).
    5. Rotate the author token in Settings (a new PAT the author pre-created). *Assert:* the next drop's payload carries the new fingerprint; the settings row shows the new date.
    6. Add the second repository; run the doctor. *Measure:* time to a green doctor.
    7. The author deletes the `agent-ready` label on the second repository and asks the partner to run the doctor. *Assert:* the partner reaches the fix through the check's action and the doctor is green again.
    8. At two scripted moments (after step 4's pause, and while step 3 waits on CI) the author asks "what is Jumpmaster doing and why is it waiting?". *Assert:* the answer matches the status line, in the partner's words.
  - **Counted per partner:** edits to any file after `docker compose up`; shell commands beyond `docker compose up` and `docker compose logs`; questions to the author; hands-on minutes (a stopwatch the author runs, paused while CI or a drop runs). The gate needs every count at zero and the minutes under 60.
  - **Recorded per partner:** the host OS and Docker version; a screen recording; the counts and times; every doctor fail and the link followed; every place they hesitated for more than a minute and what they were looking for.
- [ ] **Step 2: Dry run with the owner on the reference project** (the owner's decision under Owner steps), and adopt db mode if the owner chose it. Expected: the session completes; every hesitation becomes a fix or a wording change.
- [ ] **Step 3: Partner 1.** Expected: every count zero, under 60 minutes.
- [ ] **Step 4: Partner 2,** on a different OS if available. Expected: the same.
- [ ] **Step 5: Fix and rerun.** Every hesitation over a minute, false doctor result or doc gap becomes a test-first fix or a runbook edit. A rerun after a fix uses a new partner or a new repository pair.
- [ ] **Step 6: Have the branch red-teamed,** fix the findings test-first, and merge. Commit: `docs: add the M4.5 gate runbook`
- [ ] **Step 7: Report to the owner** with each partner's counts, times and hesitations.

**M4.5 gate (testable, run by Jumpmaster's operator):** two design partners who have never opened the config file each complete the operability session with the browser as their only interface after `docker compose up`: install to a green doctor, first PR merged, pause a zone and change a gate without a restart, rotate a token, add a second repository, recover from an injected doctor FAIL, and say from the status line what Jumpmaster is doing and why it waits; per partner, zero file edits, zero shell commands beyond `docker compose up` and `logs`, zero questions to the author, and under 60 minutes of their own hands-on time. Any count above zero fails.

The claims listed under Review Focus as resting on unit tests are accepted on those tests.

---

## Spec coverage

| Spec | Where |
|---|---|
| §3 first run as a browser flow | T1, T8 |
| §7.1 repository content is data | T4's detection, T8 |
| §7.3 two identities, starter mode, token scopes | T3's entry tests, T8's forge step |
| §7.5 UI: login, loopback, CSRF, Origin/Host, session timeout, re-auth to replace secrets | T1 |
| §7.5 every mutating call audited | T1's `control_audit` |
| §7.5 Command's MCP tokens created in the UI with expiry and scope | T5's MCP tokens tab |
| §7.5 vault: key outside the data volume, threat model in the docs | T3, T10 |
| §8.0 every failure gets a fix-it hint | T6 (a link, not only a hint) |
| §10.3 M4.5 surfaces | T4 zones, T5 settings, T6 doctor links, T7 status, T8 setup, T9 ctl |
| §12.1 the token belongs to the operator; link to the terms | T8's Claude step |
| §13 forward-only migrations, restore safety | Global Constraints (v18–v21) |
| §15 M4.5 gate | T11 |

## Deferred

| Item | Why it waits |
|---|---|
| Weight, usage budget and placement affinity on the zones page | M5. The zones page is built so M5 adds a Scheduling section; the fields don't exist in the scheduler yet. |
| Per-zone forge credentials, GitLab credentials and the GitLab adapter | M5. One author and one reviewer token serve every zone until the second forge arrives. |
| Remote stick enrollment runbook, Podman, Kubernetes | M6. The join token mints now; the runbook for a stick through NAT belongs with the placements. |
| Issue graph, flow page, CI metrics | M6. |
| Prompts registry, in-app intake chat | M7, with prompt optimization. |
| Goal-change PRs from the UI (§8.1) | Still deferred from M4. |
| Credential proxy for the Claude token (§7.2) | Still deferred from M4. |
| Vault key rotation (`ctl vault rekey`) | Re-entering each credential after a key change is a few pastes in the UI; a rekey command adds a key-management surface the gate doesn't need. |
| Multiple operators, roles, or a second login | §3: single operator per install. |
| Mixed file-and-UI config ownership | The two-mode rule exists to avoid it. |
| Per-key config watching (inotify) in file mode | `ctl config reload` is explicit and auditable; a watcher can follow if file-mode operators ask. |
| Pruning config revisions | Kilobytes each; revisit if a history page gets slow. |
| A `Secure` cookie flag and TLS termination guidance | Loopback or SSH tunnel by default; TLS guidance belongs with M6's remote placements. |
| TOTP or passkeys for the operator login | Single operator on loopback; a passphrase plus the setup code meets §7.5. |
| Doctor auto-fix beyond label creation | The doctor stays read-only; labels are the one mechanical, harmless fix. |
| Changing a stick's slot count from the UI | `JM_SLOTS` is a stick-side setting; it moves to the UI with M6's stick protocol work. |

## Red-team disposition

Empty until the plan is red-teamed.
