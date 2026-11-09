# M4 Friend-ready Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Revised after a red team (verdict "changes", 28 findings plus missing tasks, all adopted). The
> disposition table is at the end. Operator decisions built in: starter mode ships in M4 and is
> opt-in; the browser first-run setup and the vault are deferred; images are public on GHCR and
> signed keyless.

**Goal:** A stranger with Docker, a Claude subscription and a GitHub repository installs Jumpmaster from a published compose file and gets an agent PR merged, with no help from the author. To get there, M4 adds packaged images, a readiness doctor, stack presets, a minimal in-app intake, intake skills, egress control and signed images.

**Architecture:**
- **Images.** Three images ship from a release workflow: the server (no Docker socket), the stick (the only container with the socket), and the trooper in four stack presets, plus a small egress proxy. Each is pushed by digest, signed with cosign keyless signing from a tag that must be on `main`, and published with an SBOM and provenance.
- **Image trust.** The stick pulls each trooper, proxy and service image by digest and verifies it before creating anything. It refuses tags.
- **Egress.** When a zone restricts egress, each drop gets its own internal `/28` Docker network with no route out and a DNS upstream that answers nothing. Its only exit is a per-drop proxy, bound to the drop-network address, that allows CONNECT to listed public hosts.
- **Doctor.** A read-only set of server checks, plus an on-demand `doctor` drop that proves the Claude token, clone, services and gates on the default branch.
- **Intake.** A form that renders a `GOAL.md` stub and files a first ready issue through the outbox.
- **Install.** `jumpmaster init` run as the host user, then `docker compose up`.

**Tech Stack:** TypeScript (ESM, strict), Node 24+, Fastify 5, better-sqlite3, zod 4, Octokit, dockerode, vitest, Biome. New: cosign (binary in the stick image), uv (binary in the python preset), and GitHub Actions for Docker build and cosign. No new npm runtime dependency: the egress proxy uses only Node's standard library.

**Spec:** `docs/superpowers/specs/2026-10-19-jumpmaster-design.md` §1.3, §2.3, §3, §5.4, §7.1–7.5, §8.0, §8.2–8.3, §12.1, §13, §15 (M4).

## Global Constraints

- Build on `main`. Run `npm test`, `npm run typecheck` and `npx biome check .` before every commit. Image tasks also run `docker build` for each image they touch, and the image e2e job (Task 3 on) must pass in CI.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, as the owner chose for this repository. PR bodies carry no generated-with footer.
- **Naming.** This repository is public. Call the live targets "the test repository" (one per stack in the gate) and the owner's project "the reference project". No private project names, hostnames, local paths, employer names, or logins other than the repository's own. Public docs that a stranger runs (README, `SECURITY.md`, the install and release runbooks) use the repository's real `owner/name`, the one `SECURITY.md` already names, so the documented `cosign verify` commands run as written (finding #8). Code takes it as a build argument.
- **Pinning.** Every *new* dependency is pinned exactly:
  - new npm packages carry no `^` or `~` (existing dependencies keep their ranges);
  - GitHub Actions are pinned by full 40-character commit SHA, with the version in a comment;
  - every image reference (`FROM`, `COPY --from`, `ARG *_IMAGE` and `ARG BASE` defaults, compose `image:`) is an `@sha256:` digest;
  - every downloaded binary (cosign, uv, Maven, any other) has a checksum checked in the Dockerfile.

  Task 1's test enforces these shapes. Each new dependency must also be a release at least 14 days old on the day its task starts. That rule is a PR-template checklist line, not a test: record the version and release date in the commit message.
- **Defaults keep every M3 zone, the reference zone included, behaving exactly as it does now.** `egress.mode` defaults to `"off"`, `requireSignedImages` to `false`, `identity` to `"two-bot"`, and an unset `JM_IMAGE_POLICY` means `allowlist`. The *generated* install is different:
  - `jumpmaster init` writes `egress.mode: "monitor"` (flipped to `enforce` once the doctor drop shows no unlisted host) and `requireSignedImages: true`;
  - the stick image sets the `signed` policy.

  Risky choices are explicit: starter mode, `egress.mode: "off"` in a generated config, and an operator digest pin.
- Add database changes as migrations from v15 on, in the order they land: v15 stick capabilities and `last_seen_at` (Task 5), v16 doctor runs (Task 11), v17 the `doctor` role (Task 12). Never edit `schema.sql` or an earlier migration. Rollback: an M3 binary runs against v15 and v16 (ignored columns and table), but not v17 (the role CHECK changed). A full rollback past v17 is a database restore.
- Every forge write goes through `runOp` in `outbox.ts`. The doctor never writes to the forge.
- No secret value is ever printed, logged, stored in the database, placed in argv, URLs, image layers, labels or compose files, or written into a forge body. Secrets reach containers as files (`*_FILE`) or over stdin, as today. Every credential a payload carries is in `payloadSecrets`.
- §7.1 still holds. Only Command's own text (behind the operator token) enters the forge as a ready issue without a ruling. Repo content read by the doctor, by detection or by the intake skills is data.
- Every network-facing or security-relevant task lists its threats under Review Focus. Its tests cover each threat, or the threat is named as resting on the rehearsal.

## Owner steps

These change settings on the public repository or its packages, or need accounts. They are **owner-only**: the implementer stops and asks when the work reaches them.

| When | Owner-only step |
|---|---|
| Before Task 9's first tag | Add a tag ruleset on the public repository: create, update and delete of `refs/tags/v*` restricted to the owner, with no bypass for any other account (the approving agent account included). |
| Task 9, first pre-release | Push the first pre-release tag (`v0.4.0-rc.1`), which the ruleset allows only the owner to do. |
| Task 9, after the first push | Make each GHCR package public, and confirm each is linked to the repository through the `org.opencontainers.image.source` label: server, stick, egress, trooper, and the python, go and jvm presets. |
| Task 9 | Confirm the repository's Actions settings let workflows request an OIDC token (`id-token: write`) and publish packages. |
| Task 18 | Provide the gate's bot or machine accounts and their tokens, if new ones are needed (account creation is not delegated). |
| Each release after M4 | Push the version tag. |

## Rulings on spec gaps

- **Setup is file-based in M4, not a browser flow (§3) [operator decision].** Secrets live in files that compose passes as Docker secrets. Config is a JSON file that `jumpmaster init` writes. A browser setup flow needs the vault (§7.5), and in-UI secret entry needs re-auth.
- **The doctor advises, and the existing guards enforce.** "Refuses unsafe settings without an explicit Command override" (§7.4) is already true: branch-rule problems park items, and `requireBranchProtection: false` is the override. The doctor reports the same facts up front with fix hints. It never changes repository settings.
- **The doctor's live checks run in a drop.** "Claude credential works", "toolchain image builds", "a gate dry-run passes on the default branch" and "services start" (§8.0) all need a trooper. One `doctor` drop proves all four on the zone's real stick, image and egress policy. It runs only on request, because it spends a turn of usage.
- **Plan tier stays declared (§12.2).** The usage spike observed no structured plan signal. The doctor shows the declared plan and checks the Fable settings for consistency.
- **Toolchain images are prebuilt presets, not built by the stick (§5.4).** An operator who needs more builds their own image `FROM` a preset and pins it by digest (Task 10).
- **A preset chooses the image and the egress hosts, never the gates at dispatch.** Detection reads the default branch once, in `init` and in the doctor, and `init` writes explicit `gates` into the config. Gates stay config held by Jumpmaster (§5.4).
- **Egress uses one proxy per drop, on an internal network (§7.2).** Default-deny comes from the network (`Internal: true`), not from tools honouring proxy variables. The proxy allows only `CONNECT` to listed hosts on port 443, and only to public addresses. Drops never share a proxy, and each proxy listens only on its own drop's network.
- **Egress is monitor-first in the generated install.** A first real repository hits hosts no preset list can predict. `init` writes `monitor`, and the install runbook and the doctor walk the operator to `enforce` once the doctor drop shows no unlisted host. The gate requires `enforce` for the merged PR.
- **Image trust comes from the release workflow or the operator's digest pin (§7.5).** The stick accepts an image if cosign verifies a keyless signature from this repository's `release.yml` on a version tag, pushed by a `push` trigger, or if the operator pinned that exact digest. The workflow itself refuses to sign a commit that isn't on `main`, and the tag ruleset (owner step) limits who can push version tags.
- **Single-identity starter mode ships in M4, opt-in (§7.3) [operator decision].** Its residual risk is stated plainly where a stranger reads it (Task 13).
- **Minimal intake renders the `GOAL.md` stub but doesn't commit it.** `GOAL.md` is a protected path. The first issue is filed by the server as ready, because Command wrote it in the app behind the operator token. It doesn't need the ladder: the crew is off by default.
- **Intake skills run in Command's own Claude Code over the M3 MCP server (§8.2 v1).** They file staged issues, which Command promotes by ruling.

## Review Focus

1. **Egress bypass (Tasks 6–8).**
   - A tool that ignores proxy variables. The internal network gives it no route out.
   - DNS exfiltration from the trooper *or a service* through Docker's embedded resolver. Both get an upstream that answers nothing, and the CI e2e asserts that an external name doesn't resolve from either.
   - The host reachable at the drop network's gateway address. A CI e2e assertion checks it. If it connects, the install runbook adds a `DOCKER-USER` rule and the gap is stated.
   - The proxy reaching private addresses: the host, Jumpmaster, a metadata endpoint, another drop, a service, or `host.docker.internal`. It resolves names itself, refuses the connection if any resolved address isn't public (embedded-IPv4 transition ranges included), and connects only to addresses it checked, trying them in order.
   - The proxy reachable from `jm-egress-out`, where other drops or the host could use it. It binds only to its drop-network address.
   - Allow-list parsing tricks: case, a trailing dot, IP literals, non-ASCII, `host:port` smuggling, absolute-URI plain HTTP, an oversized header, a non-443 port.
   - Exfiltration through an allowed host. This residual is stated plainly. `github.com` plus the author token in an implement drop is an unbounded write channel (held by the trooper's root process, not the agent). The operator's Claude token reaches `api.anthropic.com`. Domain fronting on shared CDNs remains, where those CDNs still allow it.
   - Proxy failure falling back to open egress. A proxy that isn't ready fails the drop before the trooper exists.
   - Address-pool exhaustion. Drops use `/28` subnets from a stick-managed pool, and leaked networks are reaped.
2. **An old or incapable stick failing open (Task 5).** It must never lease a drop from a zone whose capabilities it lacks. The refusal is logged with its reason on both sides.
3. **Image trust (Tasks 9, 10).**
   - Anyone with push minting a signed release. The tag ruleset is an owner step, `release.yml` asserts the tag's commit is on `main`, and `workflow_dispatch` never pushes, signs or publishes.
   - A tag moved between verify and run. The stick uses digest refs only, pulls by digest, and creates from the verified digest (the index digest).
   - A loose identity. The regexp is `^…$`-anchored on the exact workflow path and `v<semver>(-rc.N)?` tag refs, with the `push` trigger and repository flags.
   - Verification errors treated as success. A non-zero exit, a timeout, a parse failure or a digest mismatch each refuse the image.
   - A tampered cosign. Its version and SHA-256 are pinned.
   - A poisoned or stale cache. The cache holds successes only, keyed by digest, with a TTL, persisted root-owned `0600`, and ignored if it doesn't parse.
   - A Sigstore outage stopping the factory. The warm persisted cache keeps known digests running. Everything else fails closed.
   - A non-digest operator pin. It is refused at startup.
4. **Install surface (Tasks 2, 3, 16, 17).**
   - The Docker socket, which is host-root-equivalent. Only the stick mounts it, and the README says so in those words.
   - Secrets in `docker inspect`, logs or layers. They are passed only as `*_FILE`.
   - The UI on a public interface. It is published on `127.0.0.1` only.
   - `init` printing or overwriting secrets.
   - Linux ownership. The server runs as the host user who owns the `0600` secret files, and an unreadable secret is reported by name at startup.
5. **Doctor leaks and side effects (Tasks 11, 12).**
   - A forge write. A test counts them.
   - A doctor drop with a write token. Its payload type has no `forgeToken`.
   - The read token unredacted. `payloadSecrets` includes `credentials.readToken`.
   - Secrets in doctor output.
   - The doctor page readable through DNS rebinding. The Host check applies.
   - Usage drain. Doctor drops are manual, one per zone, and never the usage probe.
   - Collisions with crew drops. They have separate unique indexes and result routing by role.
6. **Starter mode (Task 13).** The author token can merge any green PR, its own unreviewed one included, and it is held by the server and by the trooper's root process in implement, heal and resolve drops. The Claude process never holds it. Mitigations:
   - starter mode is opt-in;
   - it requires a fine-grained author PAT with no Workflows permission;
   - it requires CI, a PR rule and no bypass;
   - a verdict on an older SHA never merges;
   - the doctor warning, README and install runbook state the consequence.
7. **Intake writes (Task 14).**
   - Filing without the operator token or cross-site. Both are refused.
   - A double submit, a retry or a reload filing twice. The idempotency key is minted per submit and kept until it is confirmed.
   - Crew text skipping promotion. Only the form's fields can file ready.
   - Filing in observe, paused or killed. It is refused.
8. **Skill-driven prompt injection (Task 15).** Skill filings are staged, so they need a ruling. The skills hold no forge token, and repo text is data.

**Gate claims resting on unit tests, not the rehearsal:**
- the proxy's refusal of private, reserved and transition ranges, and the allow-list parsing tricks;
- a proxy-start failure;
- an incapable stick skipped at lease;
- a tag ref, a non-digest pin and a mismatched digest refused under `signed`;
- the Rekor-unreachable path and the tampered-cache path;
- a double intake submit;
- starter mode refusing an older-SHA verdict.

The DNS and gateway assertions rest on the CI e2e and on the gate machines' engines, not only on unit tests.

---

### Task 1: Test roots and the pin policy

**Files:**
- Create: `scripts/pins.test.ts`, `scripts/fixtures/pre-m4-deps.json`, `.github/pull_request_template.md`
- Modify: `vitest.config.ts`, `tsconfig.json`, `biome.json`, `.github/dependabot.yml`

**Interfaces:**
- `vitest.config.ts` `include` adds `scripts/**/*.test.ts`, `images/**/*.test.ts`, `deploy/**/*.test.ts` and `skills/**/*.test.ts`. Workflow tests live under `scripts/`, never under `.github/workflows/`. `tsconfig.json` references gain `apps/egress` when it exists (Task 6). Biome covers the new roots.
- `pins.test.ts` is one generic scan:
  - every image reference in `images/**`, `deploy/**` and `.github/workflows/**` (`FROM`, `COPY --from=`, `ARG *_IMAGE=` and `ARG BASE=` defaults, compose `image:` outside `${…}` placeholders) is a digest ref;
  - every `uses:` is a 40-hex SHA;
  - every `curl`, `wget` or `ADD` URL line in a Dockerfile is followed within three lines by `sha256sum -c`, `sha512sum -c` or `--checksum`;
  - every npm dependency not listed in `pre-m4-deps.json` (a snapshot of today's names) is an exact version.
- `dependabot.yml` adds the `docker` ecosystem for `images/**`.
- The PR template has the checklist line "new dependencies: exact pin, version and release date ≥14 days old recorded in the commit".

- [ ] **Step 1: Write failing tests.** Add a sentinel test under each new root that fails, and confirm each runs before removing it.

```ts
test('a FROM, COPY --from or ARG image default without @sha256 is reported with file and line', ...)
test('a uses: on a tag or short SHA is reported', ...)
test('a download line without a checksum within three lines is reported', ...)
test('a new npm dependency with ^ or ~ is reported; a pre-M4 caret dependency is not', ...)
test('the repository passes the scan', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Run: `npx vitest run scripts`. Expected: FAIL.
- [ ] **Step 3: Implement** the scan and the configuration changes.
- [ ] **Step 4: Run the full suite.** Expected: PASS, with the sentinels removed.
- [ ] **Step 5: Commit.** `chore: collect new test roots and enforce pin shapes`

### Task 2: Secrets from files and the `jumpmaster` command

**Files:**
- Create: `apps/server/src/cli.ts`, `apps/server/src/secrets.ts`
- Modify: `apps/server/src/config.ts`, `apps/server/src/ctl.ts`, `apps/stick/src/main.ts`
- Test: `apps/server/src/secrets.test.ts`, `apps/server/src/config.test.ts`, `apps/stick/src/main.test.ts`

**Interfaces:**
- `readSecret(env, name): string | undefined` reads `NAME`, or the file named by `NAME_FILE`. It is an error to set both, for the file to be group- or world-writable, for the value to contain inner whitespace, or for the file to be unreadable. That last error names the variable and the path and says `not readable by uid <n>`. One trailing newline is trimmed. The mode check uses `fstat` on the opened descriptor. `loadConfig` uses it for every `JM_*` secret and for `JM_ZONE_SECRET_*`, and the stick uses it for `JM_JOIN_TOKEN`.
- The stick reads `JM_STATE_DIR` (default `~/.jumpmaster`) for `stick.json`.
- `cli.ts` dispatches `jumpmaster serve <config>` (the default), `ctl …`, `init …` (Task 16) and `doctor …` (an alias of `ctl doctor`). `ctl` reads the operator token through `readSecret`. On the server container, run it as `docker compose exec jumpmaster jumpmaster ctl …`, never `compose run`, because a new container's loopback is not the server.

- [ ] **Step 1: Write failing tests.**

```ts
test('JM_X_FILE supplies a secret; JM_X and JM_X_FILE together is a config error', ...)
test('a group- or world-writable secret file is refused naming the variable, not the value', ...)
test('an unreadable secret file is reported by variable, path and uid', ...)
test('one trailing newline is trimmed; inner whitespace is refused', ...)
test('zone gate secrets load from JM_ZONE_SECRET_<ZONE>_<NAME>_FILE', ...)
test('the stick keeps stick.json under JM_STATE_DIR with mode 0600', ...)
test('ctl reads the operator token from JM_OPERATOR_TOKEN_FILE', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: read secrets from files and add the jumpmaster command`

### Task 3: Server and stick images, and the image e2e in CI

**Files:**
- Create: `images/server/Dockerfile`, `images/stick/Dockerfile`, `images/images.test.ts`, `.github/workflows/images.yml`
- Modify: `.dockerignore`, `images/trooper/e2e/run.sh`
- Test: `images/images.test.ts`

**Interfaces:**
- Server image:
  - a multi-stage build from the pinned `node:24-bookworm-slim` digest, with better-sqlite3 built in the build stage;
  - the runtime image has default user 10000, which compose overrides with the host uid (Task 16);
  - `WORKDIR /app`, `/data` and `/config` paths, no Docker client, `JM_CONTAINER=1`;
  - it is built to run with a read-only root and a `tmpfs` at `/tmp` for SQLite temp files;
  - label `org.opencontainers.image.source` set to the repository URL (a build argument).
- Stick image:
  - the same base; it runs as root in its container, because the socket is host-root-equivalent anyway (a non-root stick with the socket group is deferred);
  - a read-only root;
  - writable state only under `JM_STATE_DIR=/state`, which holds the enrollment, the Sigstore TUF root (`TUF_ROOT=/state/sigstore`, Task 10) and the verify cache;
  - the same source label.
- `images.yml` runs on pull requests and `main`, on GitHub-hosted Linux:
  - it builds every image without pushing;
  - it runs `images/trooper/e2e/run.sh` against the fake claude;
  - it prints `docker version` into the job summary.

  Later tasks add e2e cases: presets (Task 4), egress (Task 8), verification (Task 10) and the doctor drop (Task 12).

- [ ] **Step 1: Write failing tests.**

```ts
test('the server image ends with a non-root USER and installs no docker client', ...)
test('no Dockerfile passes a JM_ secret as ARG or ENV', ...)
test('every Dockerfile sets the org.opencontainers.image.source label', ...)
test('images.yml runs the trooper e2e and records docker version', ...)        // js-yaml
```

- [ ] **Step 2: Run them and watch them fail.** Run: `npx vitest run images`. Expected: FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Build both images and push a branch.** Expected: `images.yml` passes in CI.
- [ ] **Step 5: Commit.** `feat(images): package the server and stick, and run the image e2e in CI`

### Task 4: Stack presets and detection

**Files:**
- Create: `images/trooper/presets/python/Dockerfile`, `images/trooper/presets/go/Dockerfile`, `images/trooper/presets/jvm/Dockerfile`, `images/trooper/claude/package.json`, `images/trooper/claude/package-lock.json`, `apps/server/src/presets.ts`
- Modify: `packages/protocol/src/index.ts`, `images/trooper/Dockerfile`, `images/trooper/e2e/run.sh`, `apps/server/src/config.ts`, `apps/server/src/payloads.ts`, `.github/workflows/images.yml`
- Test: `apps/server/src/presets.test.ts`, `apps/server/src/config.test.ts`, `images/images.test.ts`

**Interfaces:**
- Protocol: `PRESETS = ['node', 'python', 'go', 'jvm'] as const`; `type Preset`.
- `presets.ts` holds `PRESET_EGRESS: Record<Preset, string[]>`, widened to the hosts real installs hit:
  - **node:** `registry.npmjs.org`, `nodejs.org` (node-gyp headers), `objects.githubusercontent.com` and `codeload.github.com` (prebuilt binaries).
  - **python:** `pypi.org`, `files.pythonhosted.org`, `objects.githubusercontent.com` (uv-managed Pythons).
  - **go:** `proxy.golang.org`, `sum.golang.org`, `storage.googleapis.com` (toolchain downloads).
  - **jvm:** `repo.maven.apache.org`, `repo1.maven.org`, `services.gradle.org`, `plugins.gradle.org`, `downloads.gradle.org`, `plugins-artifacts.gradle.org`.
- `presets.ts` also exports:
  - `type ImageLock = Record<string, string>` (image name to index digest), loaded from `/app/images.lock.json` when present;
  - `presetImage(p, lock, registry): string`: `<registry>/jumpmaster-trooper-<p>@<digest>` with a lock, and `jumpmaster-trooper-<p>:dev` without one;
  - `detectPreset(files: Record<string, string | null>): { preset: Preset | null; candidates: Preset[]; gates: GateSpec[]; evidence: string[]; problems: string[] }`;
  - `DETECT_FILES`, the root paths detection reads.
- Detection rules, in order, from root files only:

  | Preset | Signal | Gates written |
  |---|---|---|
  | node | `package.json` | `install`: `pnpm install --frozen-lockfile` (pnpm-lock.yaml), `yarn install --immutable` (yarn.lock), `npm ci` (package-lock.json), else `npm install`; then `test`, `typecheck` and `lint` for each matching `scripts` key, with the same package manager |
  | python | `pyproject.toml`, `requirements*.txt` or `setup.py` | `uv.lock`: `uv sync --frozen`, then `uv run pytest`. Else: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt` (plus `requirements-dev.txt`), or `pip install -e .` for pyproject or setup.py alone, then `.venv/bin/python -m pytest` |
  | go | `go.mod` | `go build ./...`, `go vet ./...`, `go test ./...` |
  | jvm | `mvnw`, `pom.xml`, `gradlew` | `./mvnw -B -ntp verify`, `mvn -B -ntp verify` or `./gradlew --no-daemon check`. `build.gradle*` without a wrapper is a problem |

  More than one match means `preset: null` with `candidates`. No test command found means a `problems` entry.
  - `requires-python` is compared with the shipped versions. A version outside them is a `problems` entry (`needs Python X; the preset ships 3.11 and 3.12; uv will download it under egress monitor or with objects.githubusercontent.com allowed`).
- Config: zone `preset?: Preset`. `image` is optional when `preset` is set, and `resolveImage(zone, lock)` gives it. One of the two is required, and `gates` stays required.
- Images:
  - The base trooper image doubles as the `node` preset.
  - The other presets take `ARG BASE` (a digest-ref default) and build `FROM ${BASE}`.
  - **python** ships Debian's `python3` 3.11 with `python3-venv`, plus a pinned `uv` (checksummed) and Python 3.12 installed through `uv python install` at build time. It sets `UV_PYTHON_DOWNLOADS=automatic`.
  - **go** copies `/usr/local/go` from a digest-pinned official image.
  - **jvm** copies a JDK 21 from a digest-pinned image, plus a pinned Maven with a checked SHA-512.
  - Each preset ends with the base image's setuid sweep and no `USER` change.
- The Claude CLI is installed with `npm ci` from `images/trooper/claude/package-lock.json`, which carries its integrity hash.

- [ ] **Step 1: Write failing tests.**

```ts
test('package.json with pnpm-lock.yaml yields pnpm install --frozen-lockfile then pnpm test', ...)
test('package.json scripts decide which of test, typecheck and lint gates exist', ...)
test('uv.lock yields uv sync --frozen and uv run pytest', ...)
test('requirements.txt and requirements-dev.txt yield a venv install of both, then pytest', ...)
test('requires-python >= 3.13 is a problem naming the shipped versions', ...)
test('go.mod yields build, vet and test', ...)
test('build.gradle without gradlew is a problem, not a gate', ...)
test('package.json plus pyproject.toml is ambiguous and lists both candidates', ...)
test('no recognised file yields preset null and no gates', ...)
test('PRESET_EGRESS node includes nodejs.org and objects.githubusercontent.com', ...)
test('presetImage uses the lock digest, and the dev tag without a lock', ...)
test('a zone with preset and no image resolves to the preset image; neither is a config error', ...)
test('preset Dockerfiles take a digest ARG BASE, keep the setuid sweep and set no USER', ...)
test('the trooper installs the Claude CLI with npm ci from a lockfile with an integrity hash', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** The e2e builds each preset and, as the gate user, runs `python3 --version && python3.12 --version && uv --version`, `go version`, and `java -version && mvn -v`. Add these to `images.yml`.
- [ ] **Step 4: Run the suite, and confirm the CI e2e passes.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(images): add node, python, go and jvm presets with gate detection`

### Task 5: Stick capabilities, per zone (migration v15)

**Files:**
- Modify: `packages/protocol/src/index.ts`, `apps/stick/src/client.ts`, `apps/stick/src/main.ts`, `apps/server/src/api/sticks.ts`, `apps/server/src/leases.ts`, `apps/server/src/db/migrations.ts`, `apps/server/src/db/repo.ts`, `apps/server/src/ui/pages.ts`
- Test: `apps/server/src/api/sticks.test.ts`, `apps/server/src/leases.test.ts`, `apps/server/src/db/migrations.test.ts`, `apps/stick/src/client.test.ts`

**Interfaces:**
- Protocol:
  - `STICK_CAPABILITIES = ['egress-v1', 'image-verify-v1'] as const`;
  - `ImagePolicySchema = z.enum(['allowlist', 'signed'])`;
  - the enroll and lease bodies gain `capabilities: string[]` (default `[]`), `imagePolicy` (default `'allowlist'`), `version: string` and `pinnedImages: string[]` (the stick's digest pins, which are not secrets, so the doctor can check service images).
- v15 adds four columns to `sticks`: `capabilities_json TEXT NOT NULL DEFAULT '[]'`, `image_policy TEXT NOT NULL DEFAULT 'allowlist'`, `version TEXT` and `pinned_json TEXT NOT NULL DEFAULT '[]'`. Every lease call stamps them, and stamps `last_seen_at`, which nothing writes today.
- `zoneRequirements(zone, config): { caps: Set<string>; signed: boolean }`. `egress-v1` is needed when `egress.mode` isn't `off`. `image-verify-v1` and a `signed` policy are needed when `requireSignedImages`.
- `leaseNextDrop` takes the stick's capabilities and skips queued drops from zones whose requirements the stick lacks. It never fails them.
  - When it skips any, the lease response carries `skipped: [{ zoneId, missing }]`.
  - The stick logs that reason once per minute, not every poll, along with the body of any non-2xx lease response.
  - The home page and the doctor show the incapable stick.

- [ ] **Step 1: Write failing tests.**

```ts
test('v15 adds the stick columns, keeping every stick row', ...)
test('every lease stamps last_seen_at, capabilities, policy, version and pins', ...)
test('a stick without egress-v1 skips an enforce zone drop and leases a drop from an off zone', ...)
test('a stick with allowlist policy skips drops of a zone needing signed images', ...)
test('a skipped drop stays queued with no budget consumed', ...)
test('the lease response names skipped zones and missing capabilities', ...)
test('with no zone needing a capability, an M3 stick still leases', ...)       // reference zone
test('the stick logs a non-2xx lease body and skip reasons at most once a minute', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** The stick advertises a capability only once its own task lands: `egress-v1` in Task 8, `image-verify-v1` in Task 10.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(stick): negotiate capabilities per zone so no stick runs a drop it can't restrict`

### Task 6: The egress proxy

**Files:**
- Create: `apps/egress/package.json`, `apps/egress/tsconfig.json`, `apps/egress/src/allow.ts`, `apps/egress/src/proxy.ts`, `apps/egress/src/main.ts`, `images/egress/Dockerfile`
- Modify: `tsconfig.json` (reference), `.github/workflows/images.yml`
- Test: `apps/egress/src/allow.test.ts`, `apps/egress/src/proxy.test.ts`

**Interfaces:**
- `normalizeHost(h): string | null` lowercases and strips one trailing dot. It returns null for:
  - IP literals (v4, v6 or bracketed);
  - non-ASCII names;
  - labels outside `[a-z0-9-]` (`xn--` punycode is allowed);
  - labels over 63 characters or names over 253.
- `hostAllowed(host, list)`. An entry is an exact name or `*.suffix`, which matches subdomains only, never the apex.
- `isPublicAddress(ip)`, built on `net.BlockList`, is false for:
  - **IPv4:** 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4;
  - **IPv6:** ::, ::1, `::/96` (IPv4-compatible), `100::/64`, `2001::/32` (Teredo), `2001:10::/28`, `2001:db8::/32`, `2002::/16` (6to4), fc00::/7, fe80::/10, ff00::/8, and `::ffff:0:0/96` and `64:ff9b::/96` whose embedded v4 address isn't public.
- `startProxy(o: { mode: 'monitor' | 'enforce'; allow: string[]; ports: number[]; bind: string; port: number; lookup?; log })`:
  - It listens only on `bind`.
  - Only `CONNECT host:port` is accepted. Other methods get 405.
  - A port not in `ports` (default `[443]`) gets 403.
  - In `enforce`, an unlisted host gets 403. In `monitor`, every public host is allowed.
  - It resolves all addresses. If any address isn't public, the answer is 403 `private address`. Otherwise it tries the checked addresses in order, never re-resolving, and stops at the first that connects.
  - Limits: 8 KB of headers, 64 concurrent tunnels, a 10-second connect timeout per address and a 5-minute idle timeout.
- `type EgressLogLine = { at; host; port; decision: 'allow' | 'deny'; reason?; bytesUp?; bytesDown?; ms? }`. One JSON line per tunnel goes to stdout.
- `main.ts` reads `JM_EGRESS_MODE`, `JM_EGRESS_ALLOW`, `JM_EGRESS_PORTS` and `JM_EGRESS_BIND` (required, with no wildcard default), and prints `{"ready":true}` once it is listening.
- Image: the pinned node slim digest, running as non-root, with a read-only filesystem and the source label.

- [ ] **Step 1: Write failing tests.**

```ts
test('normalizeHost lowercases, strips one trailing dot and refuses IP literals and non-ASCII', ...)
test('*.example.com matches a.example.com but not example.com or badexample.com', ...)
test('isPublicAddress refuses every listed range, including ::/96, 2002::/16, 2001::/32 and 100::/64', ...)
test('a name resolving to host.docker.internal-style private addresses is refused', ...)
test('CONNECT to an allowed host on 443 tunnels bytes both ways', ...)               // local TLS echo, fake lookup
test('when the first checked address refuses, the second is tried; no re-resolution happens', ...)
test('CONNECT to an unlisted host is 403 in enforce and allowed in monitor', ...)
test('any private address in the answer refuses the host even when listed', ...)     // rebinding
test('GET and absolute-URI requests are 405; CONNECT to port 22 is 403', ...)
test('CONNECT host:443@evil.example and a header over 8 KB are refused', ...)
test('the proxy accepts nothing on an address other than JM_EGRESS_BIND', ...)
test('main refuses to start without JM_EGRESS_BIND', ...)
test('each tunnel logs one line; the 65th concurrent tunnel is refused', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Run: `npx vitest run apps/egress`. Expected: FAIL.
- [ ] **Step 3: Implement** with `node:net`, `node:http` (the `'connect'` event) and `node:dns`.
- [ ] **Step 4: Run the tests, and build the image in CI.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(egress): add an allow-list CONNECT proxy that refuses private addresses`

### Task 7: Egress, trooper side

**Files:**
- Modify: `apps/trooper/src/main.ts`, `apps/trooper/src/roles/shared.ts`, `apps/trooper/src/gates.ts`, `apps/trooper/src/git.ts`
- Test: `apps/trooper/src/egress-env.test.ts`, `apps/trooper/src/gates.test.ts`, `apps/trooper/src/git.test.ts`

**Interfaces:**
- `scrubEnv` strips the `JM_` prefix, so `JM_EGRESS_PROXY` must be read and translated *before* anything is spawned. `proxyEnv(url, serviceNames): NodeJS.ProcessEnv` returns:
  - `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy` and `http_proxy`;
  - `NO_PROXY` and `no_proxy` set to `localhost,127.0.0.1,<service names>`;
  - `JAVA_TOOL_OPTIONS` with the `https.proxyHost`, `https.proxyPort` and `http.nonProxyHosts` properties;
  - `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

  It is merged into the agent, gate and root-git environments.
- Maven ignores JVM proxy properties, so `writeToolProxyConfig(home, url, nonProxy)` writes two files into both the agent and gate homes before the first spawn, owned by that user with mode 0600:
  - `~/.m2/settings.xml`, with a `<proxy>` stanza;
  - `~/.gradle/gradle.properties`, with the `systemProp.https.*` entries.
- git: `runGit` already spreads the scrubbed env, and libcurl reads `https_proxy`. Correction to the original rationale: PRISTINE (`GIT_CONFIG_GLOBAL=/dev/null`, `core.hooksPath`) doesn't block environment proxies. So git needs only the env from `proxyEnv`. A test pins that a clone carries `https_proxy`.

- [ ] **Step 1: Write failing tests.**

```ts
test('JM_EGRESS_PROXY becomes proxy variables in the agent and gate environments', ...)
test('without JM_EGRESS_PROXY no proxy variable or tool config is set', ...)          // off mode unchanged
test('NO_PROXY lists localhost and every service name', ...)
test('settings.xml and gradle.properties carry the proxy and are 0600, owned by each user', ...)
test('a root git clone runs with https_proxy in its environment', ...)
test('scrubEnv keeps the proxy variables and still strips every JM_ variable', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Run the suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(trooper): route agent, gates and git through the egress proxy`

### Task 8: Egress, stick side

**Files:**
- Modify: `apps/server/src/config.ts`, `apps/server/src/payloads.ts`, `packages/protocol/src/index.ts`, `apps/stick/src/docker.ts`, `apps/stick/src/driver.ts`, `apps/stick/src/runner.ts`, `apps/stick/src/main.ts`, `apps/server/src/results.ts`, `apps/server/src/ui/pages.ts`, `images/trooper/e2e/run.sh`, `.github/workflows/images.yml`, `docs/runbooks/m0-tracer.md`, `docs/runbooks/m2-cutover.md` (security notes)
- Test: `apps/server/src/payloads.test.ts`, `apps/stick/src/runner.test.ts`, `apps/stick/src/docker.test.ts`, `apps/stick/src/subnets.test.ts`, `apps/server/src/results.test.ts`

**Interfaces:**
- **Config:**
  - Zone `egress: { mode: 'off' | 'monitor' | 'enforce' = 'off'; allow: string[] = [] }`. Each `allow` entry must pass `normalizeHost` (or be `*.` plus a valid name).
  - With egress on, a zone may declare at most 6 services (the `/28` layout below).
- **Allow list:** `BASE_EGRESS = ['api.anthropic.com', 'github.com']`. The monitor rehearsal (Task 17, step 4) may extend it, and the commit that changes it records the hosts observed. The payload carries `egress?: { mode: 'monitor' | 'enforce'; allow: string[] }`, absent when the mode is `off`. `allow` = base + preset + zone, deduplicated and sorted.
- **Subnets:** `allocateSubnet(existing: string[], pool: string): string` carves `/28`s from `JM_DROP_SUBNET_POOL` (default `172.30.0.0/16`), skipping subnets held by any existing network.
  - Layout within each `/28`: `.1` gateway, `.2` proxy (static), `.3` trooper (static), `.4` the **dead DNS address**, never assigned, and services from `IPRange` `.8/29`.
  - A create conflict retries with the next subnet.
  - The install runbook also documents the daemon's `default-address-pools`.
- **Stick, when `payload.egress` is set:**
  1. Create `jm-drop-<id>-<epoch>`: `Internal: true`, with the allocated IPAM subnet and IP range, even without services.
  2. Ensure the labelled bridge network `jm-egress-out`.
  3. Pull and allow-check the proxy image. Until Task 10 lands, `JM_EGRESS_IMAGE` is added to the allow set automatically.
  4. Start the proxy at `.2` on the drop network, connected also to `jm-egress-out`, with `JM_EGRESS_BIND=<.2>` and trooper-grade hardening.
  5. Wait up to 30 s for `{"ready":true}`.
  6. Create the trooper and each service on the drop network only, with `Dns: ['<.4>']` and `DnsOptions: ['timeout:1', 'attempts:1']`, so the embedded resolver answers aliases and nothing else.
  7. Pass `JM_EGRESS_PROXY=http://jm-egress:3128` to the trooper.
  - A proxy that isn't ready fails the drop with `egress proxy failed to start`, and no trooper is created.
  - The stick logs `{"event":"egress","dropId","mode","proxy":"ready"}`.
  - Teardown removes the proxy with the services. `reapOrphans` removes proxies and drop networks by label, and the stick also sweeps leaked drop networks every 10 minutes, not only at start.
- **Driver:** `ContainerDriver.start`'s `network` comment changes from "alongside the default one" to "the only network when egress is on".
- **DNS mechanism.** The design choice is the dead in-subnet upstream. It is decided by the CI e2e on GitHub-hosted Docker and confirmed on both gate engines (Task 18). If an engine forwards anyway, that engine is refused for `enforce` and the runbook names the minimum version tested.
- **Events.** The stick posts `{ kind: 'egress', host, decision, count }` events, aggregated, with at most 200 hosts per drop. The drop page shows an Egress table with denied hosts first.
- **Capability.** The stick advertises `egress-v1`.

- [ ] **Step 1: Write failing tests.**

```ts
test('egress off leaves the payload without egress and the trooper on the default network', ...)  // M3 unchanged
test('enforce builds the allow list from base, preset and zone entries, sorted and unique', ...)
test('an egress allow entry that is an IP literal or has a path is a config error', ...)
test('allocateSubnet skips subnets held by existing networks and retries on conflict', ...)
test('with egress, the trooper and services join only the drop network with the dead DNS address', ...)
test('the proxy gets the static .2 address and JM_EGRESS_BIND equal to it', ...)
test('a proxy that never prints ready fails the drop before any trooper is created', ...)
test('teardown and the periodic sweep remove proxies and drop networks by label', ...)
test('egress log lines become aggregated egress events, capped at 200 hosts', ...)
test('the drop page lists denied hosts before allowed ones', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add an `enforce` case to the e2e, run in `images.yml`. It asserts, from the gate user:
  - `getent hosts example.com` fails;
  - `getent hosts jm-egress` succeeds;
  - a direct `curl https://example.com` fails;
  - `curl -x $HTTPS_PROXY https://registry.npmjs.org` succeeds;
  - a TCP connect to the drop network's gateway on a port the runner host listens on fails.

  From a service container it asserts `getent hosts example.com` fails. From a container on `jm-egress-out` it asserts a connect to the proxy fails.
- [ ] **Step 4: Run the suite and the CI e2e.** Expected: PASS. If the gateway assertion connects, add the `DOCKER-USER` rule to the install runbook, keep the test with the rule applied, and state the gap. Update the runbooks' security notes with the residuals listed under Review Focus 1.
- [ ] **Step 5: Commit.** `feat(stick): enforce per-drop egress on an internal network through a bound proxy`

### Task 9: Signed releases and the release runbook

**Files:**
- Create: `.github/workflows/release.yml`, `deploy/compose.yaml` (template), `scripts/render-compose.ts`, `scripts/workflows.test.ts`, `scripts/render-compose.test.ts`, `docs/runbooks/release.md`
- Modify: `images/server/Dockerfile` (`ARG IMAGES_LOCK`), `apps/server/src/presets.ts` (lock loading), `SECURITY.md`

**Interfaces:**
- **Triggers:** `push` of tags matching `v[0-9]+.[0-9]+.[0-9]+` and `v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+`, plus `workflow_dispatch` for a dry run. There are no other events. Top-level `permissions: { contents: read }`.
- **Jobs:**
  1. `guard`: checks out with `fetch-depth: 0` and fails unless `git merge-base --is-ancestor "$GITHUB_SHA" origin/main`. Every other job `needs: guard`.
  2. `troopers` (`packages: write`): builds the base trooper, the python, go and jvm presets and the egress image with `docker/build-push-action`, `provenance: mode=max`, `sbom: true` and the source label. It pushes by digest only when `github.ref_type == 'tag'`, and outputs a map of index digests.
  3. `apps` (`packages: write`): builds the server with `images.lock.json` baked in, and the stick with the release identity as build arguments. It pushes by digest under the same tag condition.
  4. `sign` (`packages: write`, `id-token: write`, `if: github.ref_type == 'tag'`): runs `cosign sign --yes <ref>@<index digest>` for every image.
  5. `publish` (`contents: write`, `if: github.ref_type == 'tag'`): renders `compose.yaml` with every image as an `@sha256:` digest, writes `images.lock.json` and `SHA256SUMS`, signs `SHA256SUMS` with `cosign sign-blob --bundle`, and attaches them to the GitHub Release.
- **Identity:** `https://github.com/<repo>/.github/workflows/release.yml@refs/tags/v…`, issuer `https://token.actions.githubusercontent.com`, trigger `push`, and repository `<repo>`. `<repo>` is the real `owner/name` in public docs and a build argument in code.
- **Compose:** `renderCompose(template, lock): string` throws on a leftover placeholder or any image without a digest.
- **`release.md` (owner-facing):**
  - the owner steps (tag ruleset, package visibility, OIDC settings);
  - how to cut `vX.Y.Z` and an `-rc.N`;
  - the exact identity string;
  - what changes, and what the stick needs, if the workflow path or the repository moves (a new stick release with the new identity; the old identity stays accepted until the operator upgrades the stick);
  - how to check the published packages are public.
- **`SECURITY.md`** gains "Verifying a release", with runnable `cosign verify` and `cosign verify-blob` commands. It also offers cosign through `docker run` of a digest-pinned cosign image, for readers without cosign installed.

- [ ] **Step 1: Write failing tests.**

```ts
test('release.yml triggers only on push of version tags and workflow_dispatch', ...)   // exact event set
test('no workflow uses pull_request_target, workflow_run or issue_comment', ...)
test('every job except guard needs guard, and guard runs merge-base --is-ancestor against origin/main', ...)
test('sign and publish run only if github.ref_type == tag; build jobs push only on tags', ...)
test('id-token: write appears only on the sign job; top-level permissions are read-only', ...)
test('every image builds with provenance mode=max, sbom true and the source label', ...)
test('renderCompose pins every image by digest and throws on a leftover placeholder or missing lock entry', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Pin each action by SHA under the pinning rule.
- [ ] **Step 4: Dry-run, then the first pre-release.** Run `workflow_dispatch` on a branch. Expected: it builds and nothing is pushed or signed. **Owner steps:** the tag ruleset, the first `v0.4.0-rc.1` tag, making the packages public. Check that the images, signatures, SBOM and provenance appear, and that `cosign verify` and an anonymous `docker pull` pass from a clean machine. Push an rc tag on a commit not on `main` from a scratch branch: `guard` must fail it.
- [ ] **Step 5: Commit.** `ci: publish signed, digest-pinned images only from tags on main`

### Task 10: The stick pulls and verifies images

**Files:**
- Create: `apps/stick/src/verify.ts`, `apps/stick/src/pull.ts`
- Modify: `apps/stick/src/runner.ts`, `apps/stick/src/docker.ts`, `apps/stick/src/driver.ts`, `apps/stick/src/main.ts`, `images/stick/Dockerfile`, `apps/server/src/config.ts`, `images/trooper/e2e/run.sh`
- Test: `apps/stick/src/verify.test.ts`, `apps/stick/src/pull.test.ts`, `apps/stick/src/runner.test.ts`

**Interfaces:**
- `pullImage(ref, deps): Promise<void>`. If the image isn't present locally, the stick pulls it by digest ref, with a 10-minute timeout and progress logged at most every 10 s. A failure fails the drop with `image pull failed: <ref>: <first line>`, with no secret in it. Today nothing pulls (finding #1).
- `imagePolicyOf(env)`: `JM_IMAGE_POLICY`, default `allowlist`. The stick image sets `signed`.
- `type Signer = { identityRegexp; issuer; trigger: 'push'; repository }`, built in from build arguments. `JM_TRUSTED_SIGNER_*` may override it for forks, and the stick logs the override at start.
- `verifyImage(ref, deps: { policy; pinned; signer; cosign; cache; now })`:
  - Under `signed`, a ref that isn't `name@sha256:<64 hex>` is refused.
  - A ref in `pinned` passes.
  - Otherwise `execFile` runs `cosign verify --certificate-identity-regexp <re> --certificate-oidc-issuer <iss> --certificate-github-workflow-trigger push --certificate-github-workflow-repository <repo> --output json <ref>`, with a 60-second timeout. It passes only on exit 0 *and* when every payload's `critical.image.docker-manifest-digest` equals the ref's digest.
  - The verified digest is the **index** digest that `build-push-action` outputs and cosign signs. Don't "fix" it by verifying a platform manifest.
- The identity regexp is `^https://github\.com/<repo>/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$`.
- **Sigstore state.** `TUF_ROOT=/state/sigstore` (writable, root-owned, 0700). The verify cache lives at `/state/verified.json`: positive results only, digest to verified-at, a 7-day TTL, root-owned `0600`. It is ignored and rewritten if it fails to parse or has the wrong owner or mode.
- **Order in `runDrop`:** for the trooper, egress and every service image, pull, then verify, then create from the digest ref, all before creating any container. A verification failure fails the drop with `image not verified: <reason>`.
- **Startup under `signed`:**
  - `cosign version` must match the pinned version, or the stick refuses to start;
  - any non-digest `JM_ALLOWED_IMAGES` entry refuses startup, naming the entry;
  - the stick advertises `image-verify-v1`, `imagePolicy` and its pins.

  It logs `{"event":"image-verified","ref","via":"cosign"|"pinned"|"cache"}` per image per drop.
- **Stick egress** (documented in the install runbook, not enforced): GHCR (`ghcr.io`, `pkg-containers.githubusercontent.com`), `tuf-repo-cdn.sigstore.dev`, `rekor.sigstore.dev`, `fulcio.sigstore.dev`, and the Jumpmaster server.
- **Stick image:** cosign at a pinned version, checked with `sha256sum -c`.
- **Config:** top-level `requireSignedImages: boolean = false` (Task 5 enforces it per zone at lease).
- **Upgrade note** for the reference zone: on the stick *image*, a locally built trooper must be pinned by digest.

- [ ] **Step 1: Write failing tests.**

```ts
test('a missing image is pulled by digest before create; a pull failure fails the drop naming the ref', ...)
test('under signed, a tag ref is refused without calling cosign', ...)
test('a pinned digest ref passes without calling cosign', ...)
test('cosign exit 0 with a matching digest passes and is cached by digest', ...)
test('cosign exit 0 with a different manifest digest is refused', ...)
test('cosign non-zero, timeout or unparsable output is refused', ...)          // Rekor or TUF unreachable
test('cosign is called with the anchored regexp, issuer, push trigger and repository flags', ...)
test('the identity regexp matches v0.4.0-rc.1 and v1.2.3, and rejects branch refs and other repositories', ...)
test('the persisted cache survives a restart; a tampered or wrongly owned cache file is ignored', ...)
test('a cached success expires after 7 days; a failure is never cached', ...)
test('a non-digest JM_ALLOWED_IMAGES entry refuses startup under signed', ...)
test('runDrop pulls and verifies trooper, egress and service images before creating any container', ...)
test('the stick refuses to start under signed when cosign is missing or the wrong version', ...)
test('allowlist policy behaves exactly as in M3', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the above. Add a CI e2e case: under `signed`, an unsigned local image is refused, and the same image pinned by digest runs.
- [ ] **Step 4: Run the suite, then rehearse against the Task 9 pre-release.** Expected:
  - a released preset is pulled, verified and run;
  - an untagged local image is refused, and runs once pinned;
  - with Rekor and the TUF CDN blocked and a cold cache, verification fails closed;
  - with them blocked and a warm cache, it still runs.
- [ ] **Step 5: Commit.** `feat(stick): pull by digest and verify image signatures before running`

### Task 11: Readiness doctor, server checks (migration v16)

**Files:**
- Create: `apps/server/src/doctor/checks.ts`, `apps/server/src/doctor/run.ts`
- Modify: `apps/server/src/forge/github.ts`, `apps/server/src/db/migrations.ts`, `apps/server/src/api/control.ts`, `apps/server/src/app.ts`, `apps/server/src/ui/pages.ts`, `apps/server/src/ctl.ts`, `apps/server/src/config.ts`, `apps/server/src/test/fakes.ts`
- Test: `apps/server/src/doctor/checks.test.ts`, `apps/server/src/doctor/run.test.ts`, `apps/server/src/forge/github.test.ts`, `apps/server/src/api/control.test.ts`

**Interfaces:**
- `type DoctorCheck = { id; zoneId: string | null; status: 'pass' | 'warn' | 'fail' | 'skip'; summary; fix?; doc? }`. `doc` is an anchor in `docs/runbooks/install.md`.
- v16 adds `doctor_runs(id PK, started_at, finished_at, results_json, drop_ids_json)`, keeping the last 20.
- Forge reads:
  - `repoAccess()` (the token account's `permissions` on the repository);
  - `listLabels()`, paginated;
  - `listDir(ref, path)`;
  - `BranchRules.requireCodeOwnerReview` and `requiresPullRequest`.
- **Honest limit (finding #21):** fine-grained PATs can't be introspected. `forge.author` and `forge.reviewer` check the *account's* repository role. Their summaries say: "account has push; the token's own permissions can't be read — a missing Contents or Issues write shows at the first push or filing". The doctor drop and the first intake filing are the live proofs.
- **Global checks:**
  - `config.listen`: warn on a non-loopback host outside a container.
  - `config.uid`: warn when the server runs as uid 0.
  - `claude.token-age`: warn from 330 days after `claude.tokenCreatedAt`; skip when undeclared.
  - `claude.plan`: shows the declared plan; warn on `fableModel` with a plan that doesn't include Fable.
  - `stick.seen`: fail if `last_seen_at` is older than 2 minutes or absent.
  - `stick.capabilities`: fail per zone a stick can't serve.
  - `stick.image-policy`: warn on `allowlist`; fail if `requireSignedImages`.
- **Per-zone checks:**
  - `forge.author`, `forge.reviewer` (two-bot only) and `forge.admin`.
  - `forge.branch-rules`: `branchProtectionProblems`, plus no PR rule. The fix explains "select GitHub Actions as the source" for an unpinned required check.
  - `forge.codeowners`: warn.
  - `forge.ci`: the no-CI path (§8.0).
  - `forge.labels`: the fix gives exact `gh label create` lines.
  - `forge.private-clone`: fail when the repository is private and no read token is configured, since the doctor drop and review need `JM_GITHUB_READ_TOKEN`.
  - `zone.preset`.
  - `zone.services`: fail for a service image that isn't a digest ref, or isn't in a capable stick's pins under `signed`. The fix gives `docker buildx imagetools inspect`.
  - `zone.egress`: warn on `off`; on `monitor`, warn listing observed hosts not in the allow list, with "flip to enforce when this is empty"; pass on `enforce`.
  - `zone.goals` (crew only).
  - `zone.identity` and `zone.doctor-drop` land as `skip` with "available after Task 13" and "after Task 12", and are filled in by those tasks.
- **Routes:** `POST /api/control/doctor` and `GET /api/control/doctor`, both behind the operator token. Page `GET /doctor`.
- **CLI:** `ctl doctor [zone] [--json]` exits 1 on any `fail`.

- [ ] **Step 1: Write failing tests.**

```ts
test('a full doctor run makes zero forge write calls', ...)
test('reviewer with the author login, without push, or as admin fails forge.reviewer', ...)
test('forge.author summary states that token permissions are not introspected', ...)
test('a private repository without a read token fails forge.private-clone', ...)
test('branch rules with bypass, without a PR rule or with an unpinned check fail with the fix text', ...)
test('no workflows and no required checks fails forge.ci under ciRequired and hints ciRequired false', ...)
test('missing labels fail forge.labels and the fix lists gh label create lines', ...)
test('a service image without a digest or not pinned on the stick fails zone.services', ...)
test('egress monitor warns with observed hosts missing from the allow list', ...)
test('stick.seen fails when last_seen_at is older than two minutes', ...)
test('zone.identity and zone.doctor-drop report skip until their tasks land', ...)
test('a 403 on a read is a fail naming the permission, never a crash', ...)
test('no secret value appears in any stored or returned check', ...)
test('ctl doctor exits 1 on a fail and 0 with only warns', ...)
test('the doctor routes need the operator token and an allowed Origin', ...)
test('v16 adds doctor_runs and keeps the last 20', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Checks run in parallel per zone, with one doctor run at a time. A thrown check becomes `fail` with the redacted message.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): add the readiness doctor's server-side checks`

### Task 12: The doctor drop (migration v17)

**Files:**
- Create: `apps/trooper/src/roles/doctor.ts`
- Modify: `packages/protocol/src/index.ts` (`payloadSecrets`), `apps/server/src/db/migrations.ts`, `apps/server/src/leases.ts`, `apps/server/src/payloads.ts`, `apps/server/src/results.ts`, `apps/server/src/doctor/run.ts`, `apps/server/src/ctl.ts`, `apps/trooper/src/main.ts`, `images/trooper/e2e/run.sh`
- Test: `packages/protocol/src/index.test.ts`, `apps/trooper/src/roles/doctor.test.ts`, `apps/server/src/db/migrations.test.ts`, `apps/server/src/results.test.ts`, `apps/server/src/leases.test.ts`

**Interfaces:**
- **Protocol:** role `doctor` with a strict payload `{ protocol, dropId, epoch, repo, model, image, gates, services?, limits?, gateSecrets?, egress?, credentials: { claudeToken; readToken? } }`. It has no `forgeToken`, issue or branch. `payloadSecrets` adds `credentials.readToken`, for every role that may carry it. `DoctorResultSchema = { claude: { ok; servedModel?; error? }; clone: { ok; sha?; error? }; services: { name; ok }[]; gates: GateResult[] }`, carried on `DropResult.doctor?`.
- **v17** rebuilds `drops` (twelve-step, `foreignKeysOff`) so `doctor` is a no-work-item role. It narrows `one_active_crew_drop` to `WHERE role IN ('crew-lead','refute','diagnose') AND state IN (…)`, and adds `one_active_doctor_drop … WHERE role = 'doctor' AND state IN (…)`.
- **Results:** `applyResult` dispatches on role *before* the `workItemId === null` crew branch (`results.ts:428` today).
- **Leases:**
  - doctor drops are lease class 3, after crew;
  - they are never leased while the zone is paused, observe or killed, or while the usage gate is closed;
  - the probe query excludes `role = 'doctor'` in SQL;
  - they are charged to no budget.
- **Request:** `ctl doctor <zone> --drop` and the page button refuse with 409 naming the mode when the zone isn't active, rather than queue a drop nothing will lease.
- **Trooper role:**
  1. Clone the default branch through the root mirror with `readToken` or none.
  2. Run the `claude -p` probe (one fixed line, `--max-turns 1`, every tool disabled, an empty root-owned cwd). It spends one turn.
  3. Run the zone's gates as the gate user, credential-less.
  - It never pushes.
- **Reporting:** `zone.doctor-drop` reports claude, clone, each service, each gate, and the egress hosts denied or (in monitor) observed.

- [ ] **Step 1: Write failing tests.**

```ts
test('a doctor payload with a forgeToken, issue or branch is rejected', ...)
test('payloadSecrets includes credentials.readToken', ...)
test('a stderr tail containing the read token is redacted in noResultReason', ...)
test('v17 lets a doctor drop and a crew drop be active in one zone at once', ...)
test('v17 refuses a second active doctor drop per zone', ...)
test('a doctor result with no work item never reaches applyCrewResult', ...)
test('a doctor drop leases after crew drops and never while paused, observe, killed or usage-gated', ...)
test('the usage probe never selects a doctor drop', ...)
test('ctl doctor --drop in observe or paused is refused naming the mode', ...)
test('the doctor role clones without a write token and never calls push', ...)
test('a failing gate makes the doctor result fail that gate; other gates still run', ...)
test('an authentication_failed init makes claude.ok false with the reason', ...)
test('applyResult stores the doctor result redacted and consumes no budget', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add a fake-claude doctor-drop case to the CI e2e.
- [ ] **Step 4: Run the full suite and the CI e2e.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: add a doctor drop that proves the token, clone, services and gates`

### Task 13: Single-identity starter mode

**Files:**
- Modify: `apps/server/src/config.ts`, `apps/server/src/outbox.ts` (`pairFor`), `apps/server/src/flow/snapshot.ts`, `apps/server/src/flow/reconcile.ts`, `apps/server/src/flow/guards.ts`, `apps/server/src/flow/decide.ts`, `apps/server/src/payloads.ts`, `apps/server/src/doctor/checks.ts`, `docs/runbooks/m1-loop.md` (link)
- Test: `apps/server/src/config.test.ts`, `apps/server/src/flow/guards.test.ts`, `apps/server/src/flow/snapshot.test.ts`, `apps/server/src/flow/reconcile.test.ts`, `apps/server/src/flow/failure-classes.test.ts`, `apps/server/src/payloads.test.ts`

**Interfaces:**
- **Config:**
  - Zone `identity: 'two-bot' | 'starter' = 'two-bot'`.
  - `JM_GITHUB_REVIEWER_TOKEN` is required unless every zone is starter.
  - A starter zone requires `ciRequired: true`.
  - A starter zone requires a fine-grained author token (`github_pat_`), as `authorMayBeAdmin` does. The runbook says it must have no Workflows permission, which can't be introspected.
- **In starter mode, `ForgePair.reviewer` is null.** Every reader handles it:
  - `snapshot.ts`: `viewerLogin`, `getBranchRules` and `botLogins` use the author only, and `trustedReviews` still excludes the author bot;
  - `reconcile.ts`: `postReview` is skipped, and the verdict is stored and shown in the UI;
  - `branchProtectionProblems` reads one identity.
- **Merges** run under the author token, behind the unchanged guards: `verdict SHA = CI SHA = head`, not already landed, the merge lock, and the protected-path park.
- **Starter rules** need a PR rule, a non-empty required-check list pinned to GitHub Actions, and no bypass for the author.
  - `requiredApprovals > 0` is a problem.
  - `dismissStaleOnPush: false` is *not* a problem in starter mode (it is moot with zero approvals).
  - A human `CHANGES_REQUESTED` on the head still blocks.
- **Review drops** carry the read token or none.
- **`zone.identity` warn text:** "starter mode: the author token can merge any green PR, including an unreviewed one; it is held by the server and by the trooper's root process in implement, heal and resolve drops. Use a fine-grained token for this repository only, with no Workflows permission, or add a reviewer identity." The README and install runbook carry the same text.

- [ ] **Step 1: Write failing tests.**

```ts
test('starter without JM_GITHUB_REVIEWER_TOKEN loads; two-bot without it is still an error', ...)
test('starter with ciRequired false, or with a classic author token, is a config error', ...)
test('a pass with reviewer null completes snapshot and reconcile', ...)
test('starter merges on an approve verdict at head with green CI and posts no review', ...)
test('starter never merges on a verdict for an older SHA', ...)                  // failure class
test('starter never merges while a human CHANGES_REQUESTED is on the head', ...)
test('starter rules requiring an approval are a problem; dismissStaleOnPush false is not', ...)
test('starter review payloads carry no write token', ...)
test('zone.identity warns with the merge-any-green-PR consequence', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the above. Two-bot behaviour is unchanged, and every existing guard and failure-class test passes unmodified.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): add opt-in single-identity starter mode`

### Task 14: Minimal in-app intake

**Files:**
- Create: `apps/server/src/intake.ts`
- Modify: `apps/server/src/api/control.ts`, `apps/server/src/app.ts`, `apps/server/src/ui/pages.ts`, `apps/server/src/crew/store.ts`, `apps/server/src/sync.ts`
- Test: `apps/server/src/intake.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/sync.test.ts`

**Interfaces:**
- `INTAKE_TEMPLATES = ['existing', 'idea', 'partial'] as const`.
- `renderGoalStub(t, a: { lighthouse: 1..2000; objectives: string[] 1..5, each 1..200; nonGoals?: string[] ≤10; constraints?: string[] ≤10 }): string`. The output always parses with `parseGoals`, with objective 1 current.
- `renderIssueSpec(i: { title: 1..120; context: 1..4000; acceptance: string[] 1..15, each ≤300; tests: string[] 1..10, each ≤300; outOfScope?: string[] ≤10 }): string`. It has the sections `## Context`, `## Acceptance criteria` (`- [ ]` items), `## Required tests` and `## Out of scope` (§8.3).
- **Routes**, behind the operator token and the Origin check:
  - `POST …/intake/goal-stub` returns `{ markdown }` and writes nothing.
  - `POST …/intake/issue` takes `{ idempotencyKey: uuid, ...issue }`. It inserts a `crew_issues` row with `source = 'intake'`, `objective = '1'`, and `key = 'intake-' + first 12 hex of sha256(idempotencyKey)`. It files through `runOp` (`create_issue`, labels `[readyLabel]`, with the marker). The state goes `filing → promoted` on confirmation. A repeated key returns the existing row.
  - It is refused with 409 in observe, paused or killed, and with 429 above 10 per zone per hour (an in-memory limit).
  - No migration: `crew_issues.source` has no CHECK.
- **Idempotency key per submit (finding #24).** The page mints the key when Submit is clicked. It keeps it in `sessionStorage` under a hash of the form's content until the server confirms, so a retry or a reload-and-resubmit of the same content reuses it, and an edited form gets a new key.
- **Page** `GET /zones/:id/intake` has three steps: template and answers; the stub with copy and commit-via-PR instructions; the first-issue form. It says "the first issue doesn't need GOAL.md merged first".

- [ ] **Step 1: Write failing tests.**

```ts
test('every template renders a stub that parseGoals accepts with objective 1 current', ...)
test('renderIssueSpec emits the four sections and one checkbox per criterion', ...)
test('intake/issue without the operator token is 401; with a foreign Origin 403', ...)
test('intake/issue files one ready issue with the marker, objective "1", through the outbox', ...)
test('the same idempotencyKey twice files exactly once', ...)
test('a 5xx after create is resolved by marker read-back, not a second create', ...)
test('intake in observe, paused or killed is 409 naming the mode', ...)
test('the eleventh intake issue in an hour is 429', ...)
test('an intake issue starts with crew.enabled false', ...)
test('a crew-filed staged issue is still not started without a ruling', ...)
test('goal-stub makes no forge call', ...)
test('the page script reuses a stored key for unchanged content and mints a new one when content changes', ...)  // jsdom-free: pure helper
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the above. All markup is escaped, and the page holds no secret.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): add a minimal in-app intake for the goal stub and first issue`

### Task 15: Intake skills

**Files:**
- Create: `skills/jumpmaster-intake-existing/SKILL.md`, `skills/jumpmaster-intake-idea/SKILL.md`, `skills/jumpmaster-intake-partial/SKILL.md`, `skills/shared/interviewer.md`, `skills/shared/scout.md`, `skills/shared/ladder-writer.md`, `skills/shared/issue-splitter.md`, `skills/skills.test.ts`
- Modify: `apps/server/src/mcp/tools.ts` (export `TOOL_NAMES`), `docs/runbooks/m3-crew.md` (link)

**Interfaces:**
- Each skill runs in Command's own Claude Code in a checkout, with the Jumpmaster MCP server connected (a write token). It follows the shared flow:
  1. Check the connection with `get_queue`.
  2. Interview, one question at a time.
  3. Scout the repository as **data**.
  4. Write `GOAL.md` on a local branch, and tell Command to open a PR (it is a protected path).
  5. After the merge, call `file_staged_issues` (at most 5), and tell Command to promote them by ruling.
- The skills never handle tokens, never label or merge through a forge CLI, and never call anything ready.

- [ ] **Step 1: Write failing tests** (collected under `skills/` since Task 1).

```ts
test('every skill has name and description frontmatter within length limits', ...)
test('every mcp__jumpmaster__<tool> named in a skill exists in TOOL_NAMES', ...)
test('the GOAL.md example in ladder-writer parses with parseGoals', ...)
test('the issue template headings equal renderIssueSpec headings', ...)
test('no skill mentions gh pr merge, gh issue edit --add-label, a token variable or ready labelling', ...)
test('every relative link between skill files resolves', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Write the skills.**
- [ ] **Step 4: Rehearse `jumpmaster-intake-existing`** on the python test repository. Expected: a parsing `GOAL.md` merged by Command, and staged issues promoted by ruling.
- [ ] **Step 5: Commit.** `feat: add intake skills for existing, idea and partly built projects`

### Task 16: `jumpmaster init` and the compose install

**Files:**
- Create: `apps/server/src/init.ts`, `deploy/.env.example`, `deploy/compose.build.yaml` (from-source override), `deploy/deploy.test.ts`
- Modify: `deploy/compose.yaml`, `apps/server/src/cli.ts`, `examples/jumpmaster.config.json` (preset-based, no tag ref)
- Test: `apps/server/src/init.test.ts`, `deploy/deploy.test.ts`

**Interfaces:**
- **Ownership on Linux (finding #4).** The server runs as the host user, not a fixed uid.
  - The runbook's first command writes `.env` with `JM_UID=$(id -u)` and `JM_GID=$(id -g)`.
  - Compose runs both `init` and `jumpmaster` as `user: "${JM_UID}:${JM_GID}"`.
  - Secret files stay `0600`, owned by that user, and `./data` is a bind mount that `init` creates.
  - `init` refuses to run as uid 0 unless `--allow-root` is given.
- **The `init` service** (compose profile `init`) mounts the install directory read-write at `/install`, never `:ro`. `jumpmaster init --repo owner/name [--preset p] [--identity two-bot|starter] [--force]`:
  - reads the author token from `/install/secrets/github_author_token`;
  - runs `detectPreset` on `DETECT_FILES`;
  - writes `/install/config/jumpmaster.config.json`: listen `0.0.0.0:7420`, `allowedHosts` `127.0.0.1:7420` and `localhost:7420`, `dataDir: /data`, `requireSignedImages: true`, and the zone with `preset`, detected `gates`, **`egress: { mode: 'monitor' }`**, `identity`, `ciRequired` true and `crew.enabled` false;
  - writes service images as digest refs;
  - creates `config/`, `data/` and `secrets/` if missing;
  - generates `join_token` and `operator_token` (0600) only if absent;
  - prints next steps.
  - It exits 2 on ambiguity without `--preset`, 3 on an existing config without `--force`, and 4 on an unwritable mount with `mount /install read-write`. It never prints a secret.
- **The `jumpmaster` service:**
  - `command: serve /config/jumpmaster.config.json`;
  - `read_only: true`, `tmpfs: [/tmp]`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`;
  - ports `127.0.0.1:7420:7420`;
  - volumes `./data:/data` and `./config:/config:ro`;
  - secrets as `*_FILE`, with `github_reviewer_token` omitted in starter mode.
- **The `stick` service:**
  - the socket mount `${DOCKER_SOCKET:-/var/run/docker.sock}`;
  - `JM_SERVER_URL=http://jumpmaster:7420`, `JM_SLOTS`, `JM_IMAGE_POLICY=signed`, `JM_EGRESS_IMAGE` and `JM_TROOPER_REGISTRY` from the lock, `JM_DROP_SUBNET_POOL`;
  - `JM_STATE_DIR=/state` on volume `jm-stick` (enrollment, `TUF_ROOT`, verify cache);
  - `read_only: true`, `tmpfs: [/tmp]`;
  - the `join_token` secret.
- **The released `compose.yaml`** carries every image digest itself, so skipping verification costs trust only in the download, not in the images.

- [ ] **Step 1: Write failing tests.**

```ts
test('init writes a config loadConfig accepts with the generated secret files', ...)
test('init with a node fixture writes preset node, its gates and egress monitor', ...)
test('init exits 2 on ambiguous detection, 3 on an existing config, 4 on a read-only mount', ...)
test('init as a non-root uid against a writable mount succeeds; as uid 0 it refuses without --allow-root', ...)
test('init never writes a secret value to stdout or stderr', ...)
test('generated secret files are 0600 and not overwritten on a rerun', ...)
test('only the stick service mounts a docker socket', ...)
test('jumpmaster and init run as ${JM_UID}:${JM_GID}; init mounts the install dir read-write', ...)
test('the jumpmaster service publishes 127.0.0.1 only, is read_only and has tmpfs /tmp', ...)
test('no compose service passes a JM_ secret as a plain environment value', ...)
test('the stick service sets JM_IMAGE_POLICY=signed and keeps state on a volume', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Dry-run on Linux and on macOS** against the Task 9 pre-release. Expected: doctor green and a merged agent PR on both.
- [ ] **Step 5: Commit.** `feat: add jumpmaster init and the compose install`

### Task 17: README and install runbook

**Files:**
- Create: `README.md`, `docs/runbooks/install.md`, `scripts/docs.test.ts`
- Modify: `apps/server/src/presets.ts` (`BASE_EGRESS`, if the monitor run finds hosts), `docs/runbooks/m1-loop.md`, `docs/runbooks/m2-cutover.md`, `docs/runbooks/m3-crew.md` (pointers)

**Interfaces:**
- **README:**
  - what Jumpmaster is;
  - **prerequisites, explicit** (finding #22):
    - Docker Engine (the versions tested in the gate);
    - a Claude Pro, Max, Team or Enterprise plan, and the Claude CLI on any machine with a browser to run `claude setup-token` once;
    - a GitHub repository, plus either two bot accounts or starter mode;
    - `gh` or the GitHub web UI for labels and rules;
    - cosign, or the `docker run` form of it, to verify;
  - the quickstart;
  - the security model, in plain words:
    - the Docker socket is host-root-equivalent and only the stick has it;
    - egress is monitor-first and then enforced;
    - images are signed;
    - residuals: the agent can read the Claude token; an implement drop holds the author token in its root process; and the starter-mode text from Task 13;
  - links to the runbooks and to Anthropic's terms, with no endorsement wording.
  - It uses the repository's real `owner/name` in commands, and `your-org/your-repo` for the user's repository.
- **`install.md`** is self-sufficient for a stranger, and its Linux path is the one rehearsed. Each step names its doctor check ids:
  1. Write `.env` with the uid and gid.
  2. Verify the release.
  3. Create the tokens. Exact permission lists:
     - author: Contents RW, Pull requests RW, Issues RW, Metadata R, no Workflows;
     - reviewer: Pull requests RW, Contents R, Metadata R;
     - read token: Contents R, for private repositories.
  4. Set the ruleset for two-bot or starter, including "select GitHub Actions as the source" for each required check.
  5. Run `init` (`docker compose --profile init run --rm init …`).
  6. Create the labels.
  7. `docker compose up -d`.
  8. Run `docker compose exec jumpmaster jumpmaster ctl doctor` to zero fails.
  9. Run `ctl doctor --drop`, add the observed hosts, flip egress to `enforce`, restart, and run the doctor drop again.
  10. Use the intake page.
  11. Watch the PR merge.
  12. Optional: the `DOCKER-USER` rule (Task 8), `default-address-pools`, and rootless Docker.
  13. Upgrade (drain, then the new release's compose file) and backup (`VACUUM INTO`).
  14. Troubleshooting by check id, including the stick's own egress hosts (Task 10).

- [ ] **Step 1: Write failing tests.**

```ts
test('every relative link in README.md and docs/runbooks/*.md resolves', ...)
test('every doctor check id exists as an anchor in install.md', ...)
test('README and install.md mention no tag-ref image', ...)
test('the cosign commands in SECURITY.md and install.md use the same identity as verify.ts', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Write the docs.** Run the `monitor` rehearsal on both test repositories, then update `BASE_EGRESS` and the preset lists test-first, recording the observed hosts in that commit.
- [ ] **Step 4: Follow `install.md` yourself on Linux** from an empty directory. Fix every gap. Expected: PASS.
- [ ] **Step 5: Commit.** `docs: add the README and install runbook`

### Task 18: Gate rehearsal: fresh agents install it unaided, on two stacks and two hosts

**Files:**
- Create: `docs/runbooks/m4-gate.md`

- [ ] **Step 1: Write the gate runbook.**
  - **Setup the operator provides** (the only inputs):
    - a Linux test host and a macOS test host, each with Docker and a clean empty directory;
    - two fresh test repositories with small seed apps (Node/TypeScript with `npm test`; Python with `pytest` and `requirements.txt`), each with a minimal CI workflow;
    - the operator's own `gh` login on the host, for repository settings only;
    - token files for a Claude setup-token and the forge identities (owner step if accounts are new);
    - the public repository URL.
  - **The agent:** a fresh Claude Code session with no CLAUDE.md, memory, skills or prior context. Its single prompt names the URL, the directory, the test repository and the token-file path, and says "use only the README and runbooks; don't ask me anything".
  - **No help:** any operator message after the prompt, or any read outside the public repository's README, `docs/runbooks/`, `SECURITY.md`, the release assets and the test repository, voids the run.
  - **Recorded per run:**
    - the host OS and `docker version` (Engine, API and containerd);
    - the transcript;
    - time to doctor green and time to merge;
    - every doctor fail seen, every doc gap hit, and the egress hosts observed and denied.
  - **Asserted per run from the stick log**, for every drop of the run, the merged PR's implement, review and merge-path drops included:
    - an `image-verified` line with `via` of `cosign` or `cache` (never `pinned`) for the trooper and egress images;
    - an `egress` line with `mode: "enforce"` and `proxy: "ready"`.

    A drop without both fails the run.
- [ ] **Step 2: Run 1, Linux, Node/TypeScript, two-bot.** Expected: the agent installs with compose, gets the doctor to zero fails, runs the doctor drop, moves egress from `monitor` to `enforce`, keeps preset `node`, files the first issue through the in-app intake, and the agent PR merges. The stick-log assertions hold.
- [ ] **Step 3: Run 2, Linux, Python, starter,** with a new fresh agent. Expected: the same, with preset `python`.
- [ ] **Step 4: Run 3, macOS, Node/TypeScript, two-bot,** with a new fresh agent. Expected: the same.
- [ ] **Step 5: Fix and rerun.** Every doc gap or false doctor result becomes a test-first fix or a runbook edit. After any fix, rerun the affected runs with new fresh agents until all three are clean.
- [ ] **Step 6: Have the branch red-teamed,** fix the findings test-first, and merge. Commit: `docs: add the M4 gate runbook`
- [ ] **Step 7: Report to the owner** with each run's measures and Engine versions. The reference project isn't touched.

**M4 gate (testable, run by Jumpmaster's operator):** for two stacks (Node/TypeScript and Python) on Linux, and for Node/TypeScript on macOS, a fresh agent given only the public README and runbooks does all of the following with no help:
- installs Jumpmaster with the compose install into a clean directory, against a fresh test repository;
- runs the readiness doctor to green (zero `fail`; each `warn` is one the install runbook names);
- picks a stack preset;
- files a first issue through the in-app intake;
- gets an agent PR merged.

The stick log shows signed, verified images and enforced egress for every drop, and one run uses starter mode.

**The spec's gate ("2 design partners reach a first PR unaided") stays the owner's.** It needs real people the owner recruits. This plan prepares it and does not claim it.

The claims listed under Review Focus as resting on unit tests are accepted on those tests.

## Deferred

| Item | Why it waits |
|---|---|
| Browser first-run setup flow, operator login sessions, encrypted vault (§3, §7.5) | Operator decision. In-UI secret entry and key management are a new security surface, and file secrets plus `init` meet the gate. |
| Adding drop zones from the UI | Zones stay in the config file, and M5 brings multi-project. |
| Plan-tier detection (§8.0, §12.2) | No structured plan signal has been observed. The doctor checks the declared plan. |
| Credential proxy for the Claude token (§7.2) | The Claude CLI needs the token in-process. The residual is stated, and egress limits where it can go. |
| Stick-built toolchain images (§5.4) | Prebuilt signed presets plus digest-pinned operator images cover the gate. |
| Key-pair signing of operator-built images | The operator's digest pin is the trust, with no key management. |
| Verifying SBOM and provenance at the stick | Published and verifiable by people. The stick checks the signature. |
| Offline or air-gapped verification | A non-goal (§2.2). A warm persisted cache rides out short Sigstore outages. |
| SNI-versus-CONNECT-host check in the proxy | An optional hardening against domain fronting, which the major CDNs already refuse. |
| A non-root stick using the Docker socket group | The socket is host-root-equivalent either way. Cheaper to audit, but not a blocker. |
| Egress control for the server container | The server runs no repo code. |
| gVisor or a hardened runtime as a stick setting | Rootless Docker is documented. It can follow with M6 placements. |
| Go and JVM presets in the gate | Built, signed and CI-smoke-tested, but not rehearsed end to end. |
| Goal-change PRs from the UI (§8.1), full in-app intake chat (§8.2 v1.x) | Still deferred. Intake renders the stub, and the chat is M7. |
| Doctor auto-fix actions | The doctor stays read-only, and its fixes are exact commands. |
| A forge comment or check for the starter verdict | An extra write path. The verdict shows in the UI. |
| Short-lived forge credentials (GitHub App tokens, §7.3) | They would close the starter-mode and implement-drop author-token residuals, but they are credential-broker work. |
| An automated dependency-age check | The 14-day rule is a PR checklist line. A scheduled API check is more than the gate needs. |
| Per-author rate limits and stranger-issue triage (§7.1) | No change from M3. |

## Red-team disposition

| # | Finding | Task | How it's addressed |
|---|---|---|---|
| 1 | Nothing pulls images | 10 | `pullImage` by digest before verify and create; a pull failure names the ref |
| 2 | Any pushed tag mints a signed release | 9, Owner | Tag ruleset (owner step); `guard` job asserts on-`main` ancestry; identity requires the `push` trigger |
| 3 | cosign can't run on a read-only stick; in-memory cache | 3, 10 | `TUF_ROOT` and the verify cache under `/state`; persisted 7-day positive cache; stick egress documented; warm-cache outage rehearsed |
| 4 | Linux install ownership | 16 | `init` profile with a read-write mount; everything runs as the host `JM_UID:JM_GID`; uid 0 refused by default; Linux dry run and gate runs |
| 5 | `readToken` not redacted | 12 | `payloadSecrets` includes `credentials.readToken`, with tests |
| 6 | Doctor drop collides with crew | 12 | v17 narrows `one_active_crew_drop`; results dispatch on role first |
| 7 | Starter residual understated | 13, 17 | Stated in the doctor warn, README and runbook; fine-grained author PAT required |
| 8 | Public install can't verify; packages private | 9, 17, Owner | Real `owner/name` in public docs; packages made public (owner step); source labels |
| 9 | DNS kill unverified across engines | 8, 18 | Dead in-subnet DNS upstream; CI e2e asserts DNS and gateway; Engine version recorded on both gate hosts |
| 10 | Enforce breaks real stacks | 4, 7, 16 | Widened preset lists; Maven `settings.xml` and Gradle properties; `init` writes `monitor` first |
| 11 | Starter misses snapshot and reconcile | 13 | Both added; `dismissStaleOnPush` relaxed; null-reviewer pass tested |
| 12 | New test roots not collected | 1 | `vitest.config.ts`, tsconfig and Biome; workflow tests under `scripts/`; sentinel tests |
| 13 | `last_seen_at` never written | 5 | v15 lease stamps it; `stick.seen` reads it |
| 14 | Doctor drop leasing and probe | 12 | Not leased outside active; probe excludes the role in SQL; `--drop` refused with the mode |
| 15 | IPv6 gaps; first address only | 6 | Ranges added; iterate the checked addresses |
| 16 | Proxy listens everywhere | 6, 8 | `JM_EGRESS_BIND` to the static `.2` drop address; e2e from `jm-egress-out` |
| 17 | Services keep live DNS | 8 | Services get the same dead DNS, tested in e2e |
| 18 | `/16` per drop exhausts the pool | 8 | `/28` from a stick-managed pool; periodic sweep; `default-address-pools` documented |
| 19 | Pin tests too narrow; npm rule; dependabot | 1 | Generic scan (`COPY --from`, ARG defaults, checksums); npm exact for new deps only; 14-day rule as a checklist; docker ecosystem added |
| 20 | Global capabilities; silent 409 | 5 | Per-zone negotiation; lease names skipped zones; stick logs bodies |
| 21 | PAT permissions not introspectable | 11 | Stated in the check summaries; live proof via the doctor drop and first filing |
| 22 | Prerequisites hidden; `compose run` for ctl | 2, 17 | Explicit prerequisites; `compose exec` documented |
| 23 | `read_only` needs tmpfs and a writable cache | 3, 16 | `tmpfs /tmp` on both; `/state` on the stick |
| 24 | Page-load key double-files; objective NOT NULL | 14 | Key minted per submit and kept until confirmed; `objective = '1'`; no migration stated |
| 25 | Dispatch reaches sign; weak verify flags | 9, 10 | `ref_type == 'tag'` guards; trigger and repository flags |
| 26 | Stale `http.proxy` rationale; JM_ scrubbed | 7 | Env-based proxy for git; `JM_EGRESS_PROXY` translated before scrubbing |
| 27 | The larger residual is github.com plus the author token | Review Focus, 17 | Stated next to the Claude-token residual |
| 28 | Which Python ships | 4 | 3.11 (Debian) plus 3.12 (uv, at build); `requires-python` checked by detection |
| M1–M8 | Missing tasks: pull, release runbook, test collection, e2e in CI, dependabot, monitor-first and `settings.xml`, stick logging and cache, README and Linux | 10, 9, 1, 3, 1, 4/7/16, 5/10, 16/17 | As above |
| — | Task 8 references 9 and 10 | 11 | `zone.identity` and `zone.doctor-drop` land as `skip` |
| — | Split tasks 1, 5 and 13 | 1–3, 7–8, 16–17 | Split as recommended |
| — | Reference-zone upgrade note; v17 rollback | 10, Global | Stated |
| — | Pinned service images visible to the doctor | 5, 11 | Stick advertises its pins; `zone.services` check |

## Errata after the second red-team pass (these override the task text)

1. **T9:** the `guard` job runs only when `github.ref_type == 'tag'`. A `workflow_dispatch` dry run builds and tests without pushing, signing or publishing, and without `guard`. Test: a dispatch run skips `guard`, `sign` and `publish`.
2. **T16/T17:** rootless Docker is **out of scope for M4** (decision). Its uid model contradicts the host-uid install. The install runbook says so in its prerequisites, `init` detects rootless and refuses with that message, and T11's `config.uid` check reports `skip: rootless unsupported in this release` rather than warn. Rootless support is added to the Deferred table.
3. **T16:** after a mid-drop restart in step 4, run `PRAGMA integrity_check` and a WAL checkpoint, and assert `ok`. On macOS, if the bind-mounted `./data` misbehaves, the compose file uses a named volume for `data` (`JM_DATA_VOLUME=named`) and the runbook documents the backup path for both.
4. **T1:** the pin scan exempts build-stage references (`COPY --from=<stage>`, where `<stage>` names an earlier `FROM ... AS <stage>`) and an explicit list of local-image files (`images/trooper/e2e/Dockerfile`, `examples/Dockerfile.pnpm`), each listed with a reason comment. Test: a stage reference passes, and an unlisted local tag fails.
5. **T4:** the python preset installs Python 3.12 with `UV_PYTHON_INSTALL_DIR=/opt/uv/python` set **for that build step only**. The directory is root-owned and world-readable, with no group or world write, and `python3.12` is linked onto PATH. The variable is deliberately **not** left in the image's `ENV`:
   - left set, a run-time download (a `requires-python` the image doesn't ship) fails with a permission error;
   - made writable, the agent could replace the interpreter the gate runs.

   At run time each user's uv finds 3.12 through PATH and downloads any other Python into its own home. The e2e runs `uv python find 3.12` and `python3.12 -V` as the agent user, and checks that the agent can write nothing in any preset's toolchain directories.
6. **T8:** the trooper derives the proxy URL from `payload.egress` (the fixed `http://jm-egress:3128`). `ContainerDriver.start` is unchanged.
7. **T11/T16:** `forge.private-clone` fails a private repo unless `reviewReadToken: true` and the read token are set. `init` sets `reviewReadToken: true` when `GET /repos/{repo}` reports private.
8. **T8:** the T8 e2e builds the proxy image locally. Pulling by digest arrives with T10.
9. **T6:** add `2001:20::/28` to the IPv6 refusal list.
