# Runbook: M0 tracer

End-to-end check that Jumpmaster M0 works: a labelled GitHub issue becomes a pull
request opened by an agent, with gate results recorded. You merge the PR by hand.

Everything runs on one machine: the server and the stick as plain Node processes,
and the trooper as a Docker container started by the stick.

> **From M1 on**, the server also requires `JM_GITHUB_REVIEWER_TOKEN` (a second bot
> account) and merges PRs itself. Follow the [M1 loop runbook](m1-loop.md) for the
> current build; this page stays as the M0 record.

## Prerequisites

- Node 24 or newer, npm, Docker (daemon running), git.
- A Claude token from `claude setup-token`.
- A GitHub account that can create a repository and a fine-grained token.

## 1. Build

From the repository root:

```sh
npm ci
npm run build
docker build -t jumpmaster-trooper:dev -f images/trooper/Dockerfile .
```

The image tag `jumpmaster-trooper:dev` is the stick's default trooper image.

## 2. Create a throwaway test repository

1. On GitHub, create a public repository, for example `your-org/your-test-repo`,
   with a README.
2. Give it a trivial `npm test`. For example, add a `package.json` on the default branch:

   ```json
   {
     "name": "your-test-repo",
     "version": "0.0.0",
     "type": "module",
     "scripts": { "test": "node --test" }
   }
   ```

   `node --test` passes when there are no test files, which is fine as a baseline.
3. Create the `agent-ready` label in the repository (Issues > Labels > New label).

## 3. Create the GitHub token

Create a fine-grained personal access token (Settings > Developer settings >
Personal access tokens > Fine-grained tokens):

- Resource owner: the account or org that owns the test repo.
- Repository access: Only select repositories, then select only the test repo.
- Repository permissions, and nothing else:
  - Contents: Read and write
  - Pull requests: Read and write
  - Issues: Read
  - Metadata: Read (granted automatically)
- Short expiry (7 days is plenty).

Do not reuse this token for anything else.

## 4. Write the config

```sh
cp examples/jumpmaster.config.json jumpmaster.config.json
```

Edit it so the drop zone points at your repo and uses the image you built:

```json
{
  "listen": { "host": "127.0.0.1", "port": 7420 },
  "dataDir": "./data",
  "pollSeconds": 60,
  "dropZones": [
    {
      "id": "main",
      "repo": "your-org/your-test-repo",
      "readyLabel": "agent-ready",
      "gates": [{ "name": "test", "run": "npm test", "timeoutMinutes": 20 }],
      "image": "jumpmaster-trooper:dev"
    }
  ]
}
```

`gates` is the list of commands run after the agent finishes; each result goes in
the PR's gate table. Optional per-zone fields: `model`, `maxTurns`.

Keep `jumpmaster.config.json` and `data/` out of git. Secrets are never put in the
config; they come from the environment.

## 5. Start the server

Tokens are read from the environment. Set them without putting values on the
command line or in shell history. In bash or zsh:

```sh
read -rs JM_CLAUDE_TOKEN && export JM_CLAUDE_TOKEN
read -rs JM_GITHUB_AUTHOR_TOKEN && export JM_GITHUB_AUTHOR_TOKEN
read -rs JM_JOIN_TOKEN && export JM_JOIN_TOKEN   # shared secret for enrolling sticks
```

(`read -rs` prompts silently; paste the value. In fish use `read -s -x NAME`.) For
the join token, paste any long random string, for example one generated with
`openssl rand -hex 24` in another window.

| Variable | Meaning |
|---|---|
| `JM_CLAUDE_TOKEN` | Claude token from `claude setup-token` |
| `JM_GITHUB_AUTHOR_TOKEN` | the fine-grained PAT from step 3 |
| `JM_JOIN_TOKEN` | any secret string; the stick must present the same one to enroll |

All three are required; the server refuses to start if one is missing. Then:

```sh
node apps/server/dist/main.js jumpmaster.config.json
```

Expect `[jumpmaster] listening on 127.0.0.1:7420`. The server is localhost-only in
M0 and has no login.

## 6. Start the stick

In a second terminal, in the repository root, with Docker running. The stick needs
the same join token:

```sh
read -rs JM_JOIN_TOKEN && export JM_JOIN_TOKEN   # same value as the server
export JM_SERVER_URL=http://127.0.0.1:7420
export JM_STICK_NAME=my-stick     # optional, default "stick"
export JM_SLOTS=1                 # optional, parallel drops, default 1
node apps/stick/dist/main.js
```

On first run it prints `enrolled as <id>` and saves a stick token to
`~/.jumpmaster/stick.json` (mode 0600). Later runs against the same server URL reuse
it, so `JM_JOIN_TOKEN` is only needed for the first enrolment. Then it polls for work
and prints `drop <id> (epoch N) leased` when it takes one. To use a different
trooper image, set `JM_TROOPER_IMAGE`.

## 7. Create the work

In the test repo, open an issue:

- Title: `Add a sum(a, b) function`
- Body: `Add a sum(a, b) function in sum.js that returns a + b, with a test in sum.test.js using node:test.`
- Label: `agent-ready`

Only issues from trusted authors are picked up; open the issue as the repo owner.

## 8. Watch

Open http://127.0.0.1:7420/ . The server syncs every `pollSeconds` (60 by default),
so the issue appears as a work item within about a minute, then a drop is queued,
leased by the stick, and runs. Watch for:

- the work item state: ready, in_flight, pr_open (or parked);
- the drop state and its events (phases, gates, rate-limit events);
- the last rate-limit event at the bottom of the page;
- click a drop to open `/drops/<id>` for detail.

The stick terminal shows lease and heartbeat activity; the server terminal logs
errors only.

## 9. Gate: pass criteria

The M0 gate passes when all of these hold:

1. A pull request exists from branch `agent/issue-N` to the default branch, whose
   body contains `Closes #N` and a gate table with a passing `test` row.
2. CI or the configured gates are green.
3. The drop at `/drops/<id>` shows state `succeeded`, with recorded gate results
   and usage.
4. No secret appears in the drop pages. Check both the page and a listing:

   ```sh
   curl -s http://127.0.0.1:7420/drops/<id> | grep -E 'sk-ant-|ghp_|github_pat_'
   curl -s http://127.0.0.1:7420/ | grep -E 'sk-ant-|ghp_|github_pat_'
   ```

   Both commands must print nothing (grep exits 1). Then search for your actual
   token values as literal strings, reading each one silently so it never lands in
   history (repeat for each token, and for `/`). In bash or zsh:

   ```sh
   read -rs v; curl -s http://127.0.0.1:7420/drops/<id> | grep -F -- "$v"; unset v
   ```

   In fish: `read -s v; curl -s http://127.0.0.1:7420/drops/<id> | grep -F -- "$v"; set -e v`.
   Each must print nothing.

Then merge the PR by hand. The issue closes automatically.

## Cleanup

- Stop the stick and server with Ctrl-C.
- Revoke the fine-grained token; run `unset JM_CLAUDE_TOKEN JM_GITHUB_AUTHOR_TOKEN JM_JOIN_TOKEN`.
- Delete `~/.jumpmaster/stick.json` if you want a fresh enrolment next time, and
  `data/` to reset server state.
- Delete the test repo.

## Security notes

M0 is a tracer, not a hardened deployment. Know the residual risks before you run it:

- **The agent can read the Claude token.** The Claude CLI needs
  `CLAUDE_CODE_OAUTH_TOKEN` in its own process environment, and the agent runs inside
  that process with full tool access, so code it runs (or code planted by the issue it
  works on) can read the token. Treat the Claude token as exposed to the repository's
  content.
- **No egress control.** The trooper container has unrestricted network access in M0;
  anything that reads a secret can also send it anywhere. Network egress control is
  planned for M4.
- **Use a repo-scoped token on a throwaway repo.** The GitHub token must be a
  fine-grained PAT limited to the single test repository with the permissions in step
  3, short-lived, and revoked afterwards. Do not point M0 at a repository that matters.
- **How the trooper protects the GitHub token.** The agent and the gates never receive
  it: their environments are scrubbed of `GH_TOKEN`, `GITHUB_TOKEN`, every `GIT_*` and
  `JM_*` variable and the token values themselves. At push time the trooper does not
  push from the agent's working copy (whose hooks and git config the agent controls).
  It first kills every other process in the container (it is PID 1 there), fetches the
  agent's commits without the token into a fresh bare repository it owns, and pushes
  from that repository to the explicit `https://github.com/<owner>/<name>.git` URL with
  hooks disabled, global and system git config ignored, and the auth header scoped to
  `https://github.com/` only. The token is passed in the environment of that one git
  command, never in argv or a config file.
- **Orphans.** If the stick dies mid-drop, its trooper container keeps running until
  the stick restarts; on startup the stick force-removes every container labelled with
  its own stick id before it leases new work.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Server log: `sync failed for zone main: ... 401` (or 403/404) | The GitHub token is wrong, expired, or lacks scope. Check it is selected for this exact repo, has the permissions in step 3, and that `repo` in the config is spelled `owner/name`. A 404 on a private repo also means the token cannot see it. |
| Server exits: `Missing required environment variables` | Export all three of `JM_CLAUDE_TOKEN`, `JM_GITHUB_AUTHOR_TOKEN`, `JM_JOIN_TOKEN` in the shell that starts the server. |
| Server exits: `Invalid config` | The message lists the failing JSON paths. |
| Stick: `JM_SERVER_URL is required` or enrol fails | Set `JM_SERVER_URL`; ensure `JM_JOIN_TOKEN` matches the server's. If the server's data was reset, delete `~/.jumpmaster/stick.json` and re-enrol. |
| Issue never appears | It needs the `agent-ready` label (the zone's `readyLabel`) and a trusted author. Wait one poll interval. |
| Nothing is leased | Check the stick is running and enrolled, and Docker is up. Stick prints `lease error:` on failures. |
| Work item `parked`, reason about no changes (drop result `no_changes`) | The agent finished without changing anything, usually because the task was unclear or already done. Open the drop for the agent's summary, clarify the issue, and re-label. |
| Work item `parked` with another reason / drop `failed` | The reason is shown on the home page and in the drop events. Common causes: a gate failed, the agent was blocked, or the trooper could not reach GitHub. |
| `rate_limit` events, or the last rate-limit event shows a status other than `allowed` | You are close to or at the Claude usage limit. A `rejected` status means the run cannot continue until the reset time shown. Wait for the reset, then re-label the issue. Automatic pausing is M1 work; see `docs/spikes/usage-signals.md`. |
| Drop `failed`: `branch agent/issue-N already exists on remote` | A previous run already pushed that branch. Delete the branch (or merge/close its PR) and re-label the issue. |
| Trooper image not found | Rebuild: `docker build -t jumpmaster-trooper:dev -f images/trooper/Dockerfile .` and make sure the zone's `image` matches. |
