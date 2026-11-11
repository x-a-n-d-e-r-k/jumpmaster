# Jumpmaster

Jumpmaster is a self-hosted orchestrator that turns GitHub issues into merged pull requests,
written by coding agents. You label an issue; Jumpmaster runs Claude Code on it in a throwaway
Docker container (a _drop_), opens a pull request from the agent's branch, has a second agent
review it, heals failing checks, and merges once the review verdict, your CI and the pull request
head all agree on one commit. Your branch ruleset and CI stay in charge: Jumpmaster merges nothing
they wouldn't.

It runs on one host with Docker Compose: a server (the queue, the UI and the GitHub and Claude
credentials), and a _stick_ that starts the drops.

## Prerequisites

- **Docker:** a rootful Docker Engine 27.0 or later on Linux (Engine 29.9.2 is the tested
  version), or Docker Desktop on macOS, with Docker Compose v2. Rootless Docker is not
  supported in this release.
- **cosign** v3, to verify the release (the [install runbook](docs/runbooks/install.md#step-1-download-and-verify-the-release)
  shows how to run it from its image instead).
- **Claude:** a Claude Pro, Max, Team or Enterprise plan, and the Claude CLI on any machine with a
  browser, to run `claude setup-token` once.
- **GitHub:** a repository with a GitHub Actions workflow that runs its tests on pull requests,
  plus either two bot accounts (an author and a reviewer) or starter mode (your account alone; see
  below). The setup wizard recommends which, and links each token page pre-filled.

## Quickstart

Five commands, copied as they are: make a directory, download the release, check its signature,
check the files, and start it.

```bash
mkdir jumpmaster && cd jumpmaster
for f in compose.yaml images.lock.json SHA256SUMS SHA256SUMS.sigstore.json; do curl -fsSLO "https://github.com/x-a-n-d-e-r-k/jumpmaster/releases/latest/download/$f"; done
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/x-a-n-d-e-r-k/jumpmaster/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-trigger push \
  --certificate-github-workflow-repository x-a-n-d-e-r-k/jumpmaster \
  SHA256SUMS
sha256sum -c SHA256SUMS
docker compose up
```

(On macOS, `shasum -a 256 -c SHA256SUMS` in place of `sha256sum -c SHA256SUMS`.) `docker compose
up` stays in the foreground so you can read its output; `docker compose up -d` followed by
`docker compose logs -f jumpmaster` does the same in the background.

Then open `http://127.0.0.1:7420` and enter the setup code from the line that starts
`JUMPMASTER SETUP CODE:`. You choose a passphrase, and the setup wizard takes you through the
Claude token, the GitHub tokens and your repository (`your-org/your-repo`), the ruleset and
CODEOWNERS files it generates for GitHub, and the doctor. Everything after `docker compose up`
happens in the browser.

On a server, reach the page through an SSH tunnel from your own machine:
`ssh -L 7420:127.0.0.1:7420 <host>`. If the first `up` stops with
`set JM_UID and JM_GID in .env to your user`, your user is not uid 1000: run the line it prints
and `docker compose up` again.

Every page has a command too: `docker compose exec jumpmaster jumpmaster ctl help` lists every
verb by page, and `ctl <verb> --help` shows one verb's forms. The
[install runbook](docs/runbooks/install.md) has the scripted install (`init`, config as code),
upgrades and troubleshooting by doctor check; the [operate runbook](docs/runbooks/operate.md)
covers running it day to day.

## Security model

- **The Docker socket is root on the host.** Only the stick mounts it; the server has no Docker
  access. Run Jumpmaster on a host where that is acceptable.
- **Egress is monitored, then enforced.** Each drop gets its own internal network whose only exit
  is a per-drop proxy. The install starts in `monitor` mode, which records every host a drop
  reaches; once the doctor drop shows the hosts your build needs, you list them and switch to
  `enforce`, which allows only HTTPS to those hosts.
- **Images are signed.** Every release image is signed with cosign keyless signing by this
  repository's release workflow, from a version tag on `main`. The stick verifies each trooper and
  proxy image against that identity, by digest, before it runs it, and never runs a tag. See
  [SECURITY.md](SECURITY.md#verifying-a-release).
- **Secrets stay secret.** A credential you enter in the browser is tested, encrypted at rest
  (AES-256-GCM, under `secrets/vault_key`, outside `data/`) and never shown back: pages show its
  fingerprint and dates. A file under `secrets/` named for the credential works too, and wins.
  No token is ever printed, logged or stored in clear. The UI listens on `127.0.0.1` only, its
  pages need the operator's login, and its control routes the operator token or a logged-in
  session. See [SECURITY.md](SECURITY.md#how-jumpmaster-guards-the-operator-and-the-secrets).
- **Your rules stay in charge.** Jumpmaster refuses to merge unless the default branch's ruleset
  requires a pull request and CI, with no bypass, and it parks any agent change to a protected path
  (`.github/**`, `GOAL.md` and others).

What remains, stated plainly:

- **The agent can read the Claude token.** Claude Code needs it in the drop. Egress limits where it
  can send it, but `api.anthropic.com` is always allowed.
- **An implement drop holds the author token in its root process** (not in the agent's process),
  to push the branch. `github.com` with that token is a write channel egress can't close.
- **Starter mode**, if you choose it:

  > starter mode: the author token can merge any green PR, including an unreviewed one; it is held by the server and by the trooper's root process in implement, heal and resolve drops. Use a fine-grained token for this repository only, with no Workflows permission, or add a reviewer identity.

  It is opt-in; see [Starter mode](docs/runbooks/install.md#starter-mode).

## Documentation

- [Install runbook](docs/runbooks/install.md): the browser install, the scripted install, config
  as code, tokens, ruleset, egress, upgrades, and troubleshooting by doctor check.
- [Operate runbook](docs/runbooks/operate.md): zones, settings, the GitHub page, the status line,
  the doctor's actions, every `ctl` verb, backup and restore, and the operability session.
- [Release runbook](docs/runbooks/release.md): how releases are built and signed, and what a stick
  needs to verify images.
- [M2 cutover runbook](docs/runbooks/m2-cutover.md): moving an existing project's agent work onto
  Jumpmaster, and the zone settings for a real project.
- [M3 crew runbook](docs/runbooks/m3-crew.md): the crew that plans issues from `GOAL.md`, and the
  MCP server.
- [SECURITY.md](SECURITY.md): reporting a vulnerability, verifying a release, and how the login,
  the guarded changes and the vault protect the install.

## Claude

Jumpmaster runs Claude Code with your own Claude subscription, under your account. Your use is
subject to Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) or
[Commercial Terms](https://www.anthropic.com/legal/commercial-terms), whichever applies to your
plan, and its [Usage Policy](https://www.anthropic.com/legal/aup). Jumpmaster is an independent
project.

## License

See [LICENSE](LICENSE).
