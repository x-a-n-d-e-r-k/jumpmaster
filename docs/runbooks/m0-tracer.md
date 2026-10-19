# Runbook: M0 tracer

End-to-end check that Jumpmaster M0 works: a labelled GitHub issue becomes a pull
request opened by an agent, with gate results recorded. You merge the PR by hand.

Everything runs on one machine: the server and the stick as plain Node processes,
and the trooper as a Docker container started by the stick.

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
export JM_JOIN_TOKEN="$(openssl rand -hex 24)"   # shared secret for enrolling sticks
```

(`read -rs` prompts silently; paste the value. In fish use `read -s -x NAME`.)

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
export JM_JOIN_TOKEN=...   # same value as the server (use read -rs as above)
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
- the last rate-limit event at the top of the page;
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

   Both commands must print nothing (grep exits 1). Also try your actual token
   values as literal search strings, without putting them in history.

Then merge the PR by hand. The issue closes automatically.

## Cleanup

- Stop the stick and server with Ctrl-C.
- Revoke the fine-grained token; run `unset JM_CLAUDE_TOKEN JM_GITHUB_AUTHOR_TOKEN JM_JOIN_TOKEN`.
- Delete `~/.jumpmaster/stick.json` if you want a fresh enrolment next time, and
  `data/` to reset server state.
- Delete the test repo.

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
| Trooper image not found | Rebuild: `docker build -t jumpmaster-trooper:dev -f images/trooper/Dockerfile .` and make sure the zone's `image` matches. |
