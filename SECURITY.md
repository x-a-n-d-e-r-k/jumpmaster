# Security Policy

Jumpmaster runs AI agents with write access to source repositories and holds Claude and forge
credentials, so we take security reports seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub's
[private vulnerability reporting](https://github.com/x-a-n-d-e-r-k/jumpmaster/security/advisories/new).

Include what you can: affected version or commit, a description of the issue, steps to reproduce,
and the impact you expect. You should get an acknowledgement within 3 business days. We'll keep
you updated as we investigate and credit you in the advisory unless you'd rather stay anonymous.

## Scope

In scope: the Jumpmaster app, the stick agent, trooper images, the MCP server, and the published
container images. Of particular interest:

- credential exposure (Claude tokens, forge tokens, vault contents)
- prompt injection that lets untrusted issue, PR, or comment text steer an agent
- escaping a drop container or reaching another project's data
- bypassing the orchestrator's merge checks or branch protection

Out of scope: vulnerabilities in Claude Code, GitHub, GitLab, Docker, or Kubernetes themselves —
please report those to their maintainers.

## Verifying a release

Every release image (server, stick, trooper and its python, go and jvm presets, and the egress
proxy) is published to GHCR by digest and signed with [cosign](https://docs.sigstore.dev/) keyless
signing by this repository's release workflow, from a version tag on `main`. The stick checks
the same signature before it runs a trooper or proxy image. Each GitHub Release also carries
`compose.yaml` and `images.lock.json` (every image by digest), a `SHA256SUMS` over them, and
`SHA256SUMS.sigstore.json`, the signature bundle for `SHA256SUMS`.

Check an image (take its digest from the release's `images.lock.json`):

```sh
cosign verify \
  --certificate-identity-regexp '^https://github\.com/x-a-n-d-e-r-k/jumpmaster/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-trigger push \
  --certificate-github-workflow-repository x-a-n-d-e-r-k/jumpmaster \
  ghcr.io/x-a-n-d-e-r-k/jumpmaster-server@sha256:<digest>
```

Check the release files, in the directory you downloaded them to:

```sh
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/x-a-n-d-e-r-k/jumpmaster/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-trigger push \
  --certificate-github-workflow-repository x-a-n-d-e-r-k/jumpmaster \
  SHA256SUMS
sha256sum -c SHA256SUMS
```

Without cosign installed, run it from its own image, pinned by digest (cosign v3.1.4). Prefix
either command with it; for `verify-blob`, the current directory is mounted at `/w`:

```sh
docker run --rm -v "$PWD:/w" -w /w ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d verify ...
```

A signature proves the image was built and signed by `release.yml` in this repository, from a
`push` of a version tag. Only repository administrators can create, move or delete version tags
(a tag ruleset on `refs/tags/v*`): that is the control on who can mint a release. The workflow
additionally refuses a tag whose commit is not on `main`. Images are published for linux/amd64
and linux/arm64 under one digest.

A signature is never withdrawn: every image this workflow has ever signed keeps verifying. A
stick under the `signed` image policy has a floor, though: it runs a drop or service image only
if its signature comes from a release tag at or above the stick's own release version (read from
the signing certificate's `release.yml@refs/tags/<tag>` identity; `vX.Y.Z-rc.N` sorts below
`vX.Y.Z`). An older release's image is refused with `image signed for <tag>, older than this stick
(<version>)`, a signature naming no release tag with `image signature carries no release tag`,
and a stick built without a release version refuses every signed image. So a newer server works
with older sticks, but no one can select an older trooper for a stick. The stick's own and egress
images, pinned by digest at install, are outside this rule; above the floor, the newest release's
`images.lock.json` decides which image a zone runs.

## How Jumpmaster guards the operator and the secrets

One operator, two credentials: the passphrase chosen in the browser (a session) and the machine
token `jumpmaster ctl` reads from `secrets/operator_token` (a Bearer token). Both reach the same
control routes, and every write through them is recorded in an audit table that holds named
fields only, never a request body or a value. The table keeps the latest 5000 rows; older ones
are deleted as new ones arrive.

### Sessions and CSRF

- **Host and Origin.** Every page and route checks the `Host` header against the allowed hosts
  (`127.0.0.1:7420` and `localhost:7420` by default), and every request that changes something,
  pages included, checks `Origin` too. A request they refuse costs nothing from the backoff below.
- **The session cookie** is `HttpOnly`, `SameSite=Strict` and `Path=/`, and `Secure` once a TLS
  terminator is declared (`JM_TLS_TERMINATED=1`). Its id is random, stored only as a hash,
  replaced at login, and ends after 12 hours idle or 7 days in all, at logout, and whenever the
  passphrase changes.
- **CSRF.** A browser's control call must carry the session's token in the `x-jm-csrf` header;
  the page holds it in a meta tag that another site cannot read. The machine token needs no CSRF
  header and never gets a session.
- **Guessing.** The passphrase is at least 12 characters, hashed with scrypt. A wrong passphrase
  or setup code makes that source wait 1 second, doubling to 5 minutes; nobody is locked out,
  and one source cannot slow another.
- **Re-authentication (sudo).** Writing, testing or removing a credential and making an MCP
  token (its value is shown once) need the passphrase entered again within the last 5 minutes.
  The machine token is always allowed: whoever holds it holds `secrets/`.
- **Plain HTTP stays on the host.** The UI is published on `127.0.0.1` only. The doctor's
  `config.listen` fails if the allowed hosts name another address without a declared TLS
  terminator, since the passphrase would cross the network in clear; from another machine, use
  an SSH tunnel.

### Guarded changes and the confirmation page

Guarded changes are the config changes that let more code run, let a drop reach more, hand a drop
a credential, or weaken a merge guard (a new project, an egress allow entry, turning off
`usage.stopOnOverage`, turning on `mcp.enabled`, and others). From a browser session such a
change is held and shown on a confirmation page that says what it allows; it applies only when
that page is posted with the passphrase and a confirmation that is random, minted when the page
is drawn, stored hashed, bound to the session, the exact change and the config revision it was
judged against, good for 5 minutes and used once. A changed config or a second use is refused.
Rollbacks, imports and re-added zones are judged the same way, on whole documents.

Two changes a browser session never makes, confirmed or not, because they decide what runs with
the secrets: turning `requireSignedImages` off (for the install or a zone) and setting a zone's
`image`. Make them with `jumpmaster ctl` or in the config file. The machine token's changes are
the operator's own; each is audited.

### The vault and its key

A credential entered in the browser (or with `ctl secrets set`) is tested, then encrypted with
AES-256-GCM under a 32-byte key in `secrets/vault_key` (`JM_VAULT_KEY_FILE`), which the
`bootstrap` service creates beside the other machine secrets, outside `data/`. The database keeps
only the ciphertext, so `data/` alone holds only ciphertext: a copy of the database or a backup
of `data/` reveals no credential without the key. Keep `secrets/` and
`data/` together and back them up together. A server whose vault holds entries and whose key
file is missing refuses to start; a key that does not open the entries is the doctor's
`vault.key`, and those credentials must be entered again.

Pages show a credential's source, a fingerprint (the first 8 hex characters of its SHA-256) and
its dates, never the value. A value that fails its test is treated as a secret too: it reaches
no log, audit row or response.

### The GitHub App private key

In GitHub App mode, each app's private key is the install's most powerful GitHub secret for its
owner. It mints `contents: write` tokens, merge included, on every repository the app's
installation covers, and it does not expire. On **All repositories** that is every repository of
the owner, including ones created later; on selected repositories, those. Jumpmaster narrows
every token it mints to one repository (see below), but the key itself is not narrowed.

The key lives in the vault entry `github-app/<owner>/<role>` (encrypted under the vault key, like
every entry), or in the file `secrets/github-app/<owner>/<role>.json`. The server refuses that file
when its group or others have any permission bit: keep it at mode `0600`. The key never leaves the
server: no stick, container, page or response receives it, and it is scrubbed from logs, as a whole
and line by line. Back it up with the vault key, since the vault entry is unreadable without it.
GitHub offers no API for rotating it: generate a new key on the app's page on GitHub, paste it
into **Replace key** on System → Credentials, where Jumpmaster tests it with GitHub before
storing it, then delete the old key on the app's GitHub page. See
[Rotating an app's private key](docs/runbooks/operate.md#rotating-an-apps-private-key).

### File secrets by name

A file under `secrets/` named for a credential (`claude_token`, `github_author_token`,
`github_reviewer_token`, `github_read_token`), a GitHub App entry file
`secrets/github-app/<owner>/<role>.json`, or a `*_FILE` variable, is a file secret: it wins over
the vault and is read with the same checks as the machine secrets (a regular file, mode `0600`).
Only those names count. When a file and a vault entry both exist and differ, the
doctor's `credential.shadowed` says so.

### The setup code

A fresh install has no operator. The server prints a setup code, printed once per start on the
server's stderr, on its own line beginning `JUMPMASTER SETUP CODE:`; entering it in the browser
is what lets someone choose the passphrase. It goes to stderr rather than to a file because the
person installing is already reading that output (`docker compose up`, or
`docker compose logs jumpmaster`), and a file would protect against nobody who can read the log.
The code is random (60 bits), compared in constant time, slowed by the per-source backoff, never
stored, put in a page, a cookie or a URL, and invalid once a passphrase exists.
`jumpmaster ctl setup-code` prints a fresh one. If you ship container logs to another system, a
log you forward elsewhere carries the code until it is claimed: claim the install promptly, or
let only people you trust read those logs.
`jumpmaster ctl setup reopen` (the machine token only) starts over: it removes the operator,
ends every session and prints a new code.

## Where the write token goes

An agent reads whatever is in its container, so Jumpmaster keeps the credential that can push out
of every container an agent runs in.

- **The agent's container never pushes.** An implement, heal or resolve drop clones with a read
  credential (on a GitLab zone, from a local mirror with none), runs the agent and its gates, and ends with a push request: the gated commit, or a
  checkpoint of an interrupted run. Its working copy is on a per-drop Docker volume, the
  container's only mount (a GitLab drop's container also mounts a read-only mirror, below), and
  nothing secret is written there: the payload's credentials arrive on stdin.
- **The push container is agent-free.** The stick posts the result first (the server records
  `push_pending`), confirms the agent's container is removed, and then starts a push container on
  the volume. It runs the stick's own trooper image, verified under the stick's image policy (never
  the zone's image, so no project tooling), starts no agent, and keeps the trooper's dropped
  capabilities, `no-new-privileges` and limits. Under egress it gets its own proxy that allows only
  `github.com`, or a GitLab zone's own host.
- **The token arrives last.** The push container's payload carries no credential. It copies the
  branch out of the agent's working copy into a root-owned bare repository through `upload-pack`,
  run as the agent's uid and hardened (`core.fsmonitor=false`, `core.hooksPath=/dev/null`,
  `GIT_NO_LAZY_FETCH=1`), so hooks, a planted fsmonitor or a promisor remote in the working copy
  never run with root or near the token. It then kills every agent-uid process, refuses to continue
  if any survive, and only then prints a ready line. The stick asks the server for the grant only
  after that line, and writes it on the container's stdin.
- **The server decides the push.** The grant (credential, branch, base, lease, the gated SHA,
  protected paths and the secrets to sweep for) comes from the server, which re-checks the drop's
  role, the push kind, the branch, the repository, the zone's mode and the kill switch on every
  request, and holds one reservation per drop. The secrets list is the drop's own; the reviewer
  token, the join token and other zones' secrets never leave the server. The grant is revoked when
  the push result arrives, and nothing from it is written on the stick's host.
- **The pre-push check** in the push container refuses protected paths, secrets in added lines or
  messages, unexpected commit identities, and a head that isn't the gated commit. It pushes with
  `--force-with-lease`, so a branch someone else moved is never overwritten.

**On a GitLab zone**, no GitLab token is ever in a container an agent runs in:

- **A clone container fetches the project.** Before the drop starts, the stick runs its own trooper
  image in a clone container on its own network. No agent runs there, and under egress it reaches
  only the zone's GitLab host. The stick writes the token to its stdin only after it prints a ready
  line.
- **The token** is the zone's read deploy token (`gitlab-pat/<zone>/read`, `read_repository` only)
  when one is set, else the author token. With the deploy token set, the author token leaves the
  server only for pushes. A GitLab token can't be revoked when the clone ends.
- **The mirror.** The clone container fetches into a mirror volume, refuses every redirect,
  checks that the token is in no file it wrote, and exits. The stick confirms that it is gone
  before the agent's container starts. That container mounts the mirror read-only at `/jm/mirror`
  and makes no call to GitLab.

**In GitHub App mode** (two-bot zones whose roles resolve to their owner's apps), no write token
is ever in a container an agent ran in:

- **The agent's container gets a `contents: read` token** minted for that drop alone, narrowed to
  the zone's one repository, and revoked when the drop ends.
- **The push container's `contents: write` token** is minted per push, only for the push
  container, narrowed to the zone's one repository, and revoked when the push result
  arrives.
- **The kill switch suspends the installations** the zones use, which kills their live tokens and
  refuses new ones until it is released.
- **Minted tokens are never stored.** They are held in the server's memory only: never written to
  the vault, and never written on the stick's host.

No app has the Administration or the Workflows permission. An app with Administration could edit
or bypass the rulesets that keep merges behind the review and checks, and without Workflows GitHub
refuses a push that changes the CI configuration, so agent code can't run arbitrary CI with the
repository's secrets.

**The PAT-mode caveat.** With tokens (starter mode, or two-bot zones on tokens), the grant carries
the author token, and "no write token in a container an agent ran in" holds only when a read token
is configured, as before. The agent's container clones with `githubReadToken` when one is
configured, and with the author token when none is. Without a read token, the author token is
still inside the agent's container for its clone; what changes is that the push happens only in
the push container. Configure a read token (Contents: Read-only) to keep the author token out of
agent containers, on a public repository too. In either mode, the Claude token is always readable
by the agent (see the install runbook's Claude token section).

The stick holds the Docker socket, which is root on its host: a compromised stick can ask for a
grant only for drops it holds, one repository each, and only after their agent run.

## Supported versions

Jumpmaster is pre-release. Until 1.0, only the latest commit on `main` is supported.
