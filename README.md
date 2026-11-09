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
  version), or Docker Desktop on macOS, with Docker Compose 2.24 or later. Rootless Docker is not
  supported in this release.
- **Claude:** a Claude Pro, Max, Team or Enterprise plan, and the Claude CLI on any machine with a
  browser, to run `claude setup-token` once.
- **GitHub:** a repository with a GitHub Actions workflow that runs its tests on pull requests,
  plus either two bot accounts (an author and a reviewer) or starter mode (your account alone; see
  below).
- **`gh`** (the GitHub CLI) or the GitHub web UI, for the labels and the branch ruleset.
- **cosign**, or Docker to run cosign from its image, to verify the release.

## Quickstart

The [install runbook](docs/runbooks/install.md) is the full procedure, with every token permission
and every doctor check explained; this is its outline. Replace `your-org/your-repo` with your
repository.

```sh
mkdir -p ~/jumpmaster && cd ~/jumpmaster
printf 'JM_UID=%s\nJM_GID=%s\n' "$(id -u)" "$(id -g)" > .env
mkdir -m 700 secrets

# Download the release (the first is v0.4.0-rc.1), then verify it (install runbook, step 2).
VERSION=v0.4.0-rc.1
BASE="https://github.com/x-a-n-d-e-r-k/jumpmaster/releases/download/$VERSION"
for f in compose.yaml images.lock.json SHA256SUMS SHA256SUMS.sigstore.json; do curl -fsSLO "$BASE/$f"; done

# Write the tokens to secrets/ (mode 0600): claude_token, github_author_token, and
# github_reviewer_token (install runbook, step 3). Set the branch ruleset (step 4). Then:
docker compose --profile init run --rm init --repo your-org/your-repo
gh label create agent-ready --repo your-org/your-repo --color 0E8A16 --description "Ready for a Jumpmaster agent"
gh label create agent-retry --repo your-org/your-repo --color FBCA04 --description "Ask Jumpmaster to retry a parked issue"
docker compose up -d
docker compose exec jumpmaster jumpmaster ctl doctor
```

Fix what the doctor reports until it shows `0 fail`, run the doctor drop and move egress from
`monitor` to `enforce` (step 9), then open `http://127.0.0.1:7420/` and file your first issue from
the zone's intake page.

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
- **Secrets are files.** Tokens live in `secrets/` (mode `0600`) and reach containers as Docker
  secrets; none is ever printed, logged or stored in the database. The UI listens on `127.0.0.1`
  only, and its control routes need the operator token.
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
## Documentation

- [Install runbook](docs/runbooks/install.md): the install, tokens, ruleset, egress, upgrades,
  backups, and troubleshooting by doctor check.
- [Release runbook](docs/runbooks/release.md): how releases are built and signed, and what a stick
  needs to verify images.
- [M2 cutover runbook](docs/runbooks/m2-cutover.md): moving an existing project's agent work onto
  Jumpmaster, and the zone settings for a real project.
- [M3 crew runbook](docs/runbooks/m3-crew.md): the crew that plans issues from `GOAL.md`, and the
  MCP server.
- [SECURITY.md](SECURITY.md): reporting a vulnerability and verifying a release.

## Claude

Jumpmaster runs Claude Code with your own Claude subscription, under your account. Your use is
subject to Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) or
[Commercial Terms](https://www.anthropic.com/legal/commercial-terms), whichever applies to your
plan, and its [Usage Policy](https://www.anthropic.com/legal/aup). Jumpmaster is an independent
project.

## License

See [LICENSE](LICENSE).
