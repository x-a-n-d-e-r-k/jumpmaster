# Runbook: M2 cutover

Moves a real repository from another automation system onto Jumpmaster. The two systems must never
both act on one repository, so work moves in stages, and Jumpmaster only starts writing at stage 5.

Follow the [M1 loop runbook](m1-loop.md) first: it covers the build, tokens, the stick and the
ruleset. This page covers what's different for a real project.

## Controls

The server now requires `JM_OPERATOR_TOKEN`, at least 32 characters and different from every other
token. Keep it out of any container and any repository.

```sh
export JM_OPERATOR_TOKEN JM_SERVER_URL=http://127.0.0.1:7420
node apps/server/dist/ctl.js pause main     # no new work, no reviews or merges posted
node apps/server/dist/ctl.js resume main
node apps/server/dist/ctl.js observe main   # refused until the zone is drained
node apps/server/dist/ctl.js kill           # also on the home page
node apps/server/dist/ctl.js unkill
```

| Mode | Reads the forge | Starts work | Writes to the forge |
|---|---|---|---|
| `active` | yes | yes | yes |
| `paused` | yes | no | a running drop's push and PR only |
| `observe` | yes | no, it records what it would do | no |

A zone's `mode` in the config only applies the first time the server sees that zone. After that
the stored mode wins, including across restarts.

If you open the UI or control routes through anything but loopback, list that `host:port` in
`listen.allowedHosts`, or they're refused. Stick routes aren't affected.

### Emergency stop

The kill switch cancels every drop and refuses all new work, and it survives a restart until you
reset it. The server's own PRs, reviews and merges stop immediately. Each stick hard-kills its
container at its next heartbeat, so nothing checkpoints or pushes after that. Three limits:

- **A trooper keeps running for up to 15 seconds,** until that heartbeat, and a push it starts or
  has under way in that window will land. It can't become a PR or a merge until you reset.
- **Tokens stay valid.** Revoke them with GitHub and Anthropic if they may be compromised.
- **A stick cut off from the server** kills its own drop after `JM_LOST_SERVER_KILL_BEATS` missed
  heartbeats (default 3, about 45 seconds).

If the server itself is unreachable, stop containers on the stick's host with `docker kill`.
**Don't use `docker stop`**: it lets the trooper checkpoint and push.

`jm:hold` on a PR stops work on that PR only. See the M1 runbook.

### Lease order

Since M3, queued drops lease by role class first and age second: finishing work (`review`, `heal`,
`resolve`), then `implement`, then crew roles. So a review queued after an implement drop can lease
before it. With one free slot, crew drops wait until no finishing or implement drop is queued.

## Zone settings for a real project

```json
{
  "image": "my-project-trooper:1",
  "mode": "observe",
  "gates": [{ "name": "test", "run": "pnpm install --frozen-lockfile && pnpm test", "timeoutMinutes": 40 }],
  "limits": { "pids": 4096, "memoryMb": 16384, "shmMb": 1024 },
  "services": [
    {
      "name": "db",
      "image": "postgres:16-alpine",
      "port": 5432,
      "env": { "POSTGRES_PASSWORD": "throwaway" }
    }
  ],
  "gateSecrets": ["TEST_DATABASE_URL"],
  "verification": [
    {
      "name": "ui",
      "paths": ["apps/web/**"],
      "run": "pnpm screenshots",
      "artifacts": "screenshots/**",
      "timeoutMinutes": 15
    }
  ],
  "adoptPulls": [],
  "maxConcurrentImplement": 1,
  "reviewReadToken": true
}
```

- **Image:** derive from the trooper image, as in `images/trooper/examples/Dockerfile.pnpm`.
  Allow-list it, and every service image, with `JM_ALLOWED_IMAGES`.
- **Limits:** the default of 512 counts threads and is too low for many large test suites. A gate
  that hits it says so in its output.
- **Services:** run on an internal network for one drop. The agent and the gates get
  `JM_SERVICE_DB_HOST` and `JM_SERVICE_DB_PORT`, and the agent's system prompt names each service.
  Point the project's own variable at them in its docs (for example a test-database URL). Containers are never pulled automatically, so `docker pull` each image on
  the stick's host first.
- **Gate secrets:** each value comes from `JM_ZONE_SECRET_<ZONE>_<NAME>`. **Any PR's gate code,
  including an install script, can read and send these.** Jumpmaster has no egress control until
  M4, so use only throwaway or sidecar-local values, never a real credential.
- **Verification:** runs during review with no credentials. A matching PR must produce at least
  one PNG, JPEG, WebP or JSON artifact, 10 at most and 5 MB each. Artifacts are stored and linked
  from the drop page, and the reviewer inspects them. Treat them as readable by anyone with access
  to that page. A browser step needs `--no-sandbox`, because the image has no setuid binaries, and
  an `shmMb` limit.
- **Concurrency:** raising `maxConcurrentImplement` adds conflicts that resolve drops must fix.
  Start at 1.
- **Attribution:** `"attribution": false` stops the agent adding Claude's co-author trailer and
  PR attribution, for projects whose policy forbids them. Jumpmaster's own PR and review text
  never carries a tool footer.
- **Memory:** `memoryMb` also caps swap for the trooper container, so it can't thrash a host it
  shares with other work. Service sidecars have no memory limit yet.
- **pnpm:** pin pnpm 10 or later in the root `package.json` (`packageManager`), run that
  version in the image, and set `"trustPnpmBuildBlocking": true`. Otherwise every new package in
  `pnpm-lock.yaml` parks `gate tool changed: dependency added: …`. Packages allowed to build are
  still reported. `pnpm-workspace.yaml`, `.pnpmfile.cjs` and `patches/**` are protected
  paths: a PR that touches them always waits for a person.
- **Gate-change override:** a PR that parks `gate script changed` or `gate tool changed` goes on
  once someone with maintain or admin (or a login in `overrideApprovers` with write access)
  approves its current head on GitHub. Any new push needs a new approval. In starter mode the
  operator's own account is the bots' token, so the operator's approval never counts; rule
  `Allow these gate changes for <sha7>` on the item's parked briefing instead (m1-loop runbook,
  section 3). That ruling binds to the head it names: a new push parks again.
- **Git hooks:** a project's hooks (husky, lint-staged) run on the agent's commits, but not on the
  trooper's own housekeeping commits, so a hook can't fail a drop after the work is done.

## Stages

Before stage 5, rollback is: stop Jumpmaster. Nothing was written.

### 1. Prepare

Configure the zone as above with `"mode": "observe"`. For a private repository, set
`JM_GITHUB_READ_TOKEN` and `"reviewReadToken": true`. List open agent PRs in `adoptPulls`, so
observe sees PR decisions too. Each one's issue must carry the ready label, or it appears as
`adopt_refused`.

**Pass:** the server starts, and `/observations` fills up within a few passes.

### 2. Observe

Run this alongside the old system for at least a day. Compare `/observations` to what it really
does, and investigate each difference.

- `would_enqueue:review` is the steady state for a PR, because observe never produces a verdict.
  Later decisions (post, merge, heal) only appear for PRs with verdicts from an earlier active run.
- `would_park` is the most useful signal: protected paths, changed gate scripts and tools, and
  branch protection problems all show up here. A `gate tool changed: dependency added` on every
  dependency PR means pnpm is not pinned to 10 or later, or `trustPnpmBuildBlocking` is off
  (see Zone settings).
- `would_enqueue:resume` means a ready issue has an old `agent/issue-N` branch that would be
  continued. Delete the branch or accept it for each one.
- `adopt_refused` lists PRs that won't be adopted, and why.
- `would_wait:blocked` means a ready issue has an open GitHub "blocked by" link, so it won't
  start until every blocker closes. A change to the blocker set adds a new row, so count issues,
  not rows. `unreadable blocker` means the link points at an issue the author token can't see;
  the issue waits rather than guess.

Jumpmaster reads only GitHub's native issue dependencies. It ignores labels such as `blocked`
and dependency markers in issue bodies that other tools use, so convert those to "blocked by"
links before stage 5, or the blocked issues become startable.

**Pass:** you can explain every difference.

### 3. Drain

Stop the old system and let its work finish. Refresh `adoptPulls` with the PRs still open, keeping
only one in the first batch.

**Pass:** the old system has nothing running and can't start anything.

### 4. Protect

**This binds everyone.** With no bypass list, the owner's own hand-opened PRs need an approval from
someone else too, and so do all other collaborators' PRs. Decide this deliberately.

1. Export the current settings:
   `gh api repos/OWNER/REPO/branches/main/protection > classic-protection.json`
2. Create the ruleset from section 2 of the M1 runbook, with each required check pinned to its app
   and an empty bypass list.
3. Remove the classic protection only once the ruleset is active.
4. Confirm `/` shows no `unsafe branch protection` reason, and that this reads `never` for both
   tokens: `gh api repos/OWNER/REPO/rulesets/ID --jq .current_user_can_bypass`

**Rollback:** delete the ruleset and restore the export.

### 5. Switch

1. `ctl resume main` with one adopted PR and one issue. Watch it through to a merge.
2. Add more PR numbers to `adoptPulls` in batches, restarting the server each time.
3. Release the backlog by labelling issues.

Keep the old system stopped but installed.

**Pass:** one week of normal work with no hand-merges and no unexplained parks.

**Rollback:** `ctl pause main`, then let the old system continue. Check first how it treats PRs and
markers Jumpmaster left behind, since that differs per system.

### 6. Retire

After the week holds, remove the old system and any accounts it needed.
