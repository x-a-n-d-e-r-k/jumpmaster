# Runbook: M3 crew

> **New install?** Start with the [install runbook](install.md): it installs a published release
> with Docker Compose. This runbook turns on the crew for an installed zone.

The crew reads the objective ladder in `GOAL.md`, files candidate issues under a staged label, tries
to refute each one, and raises briefings. Command (you) rules on those briefings in the UI. A crew
drop never writes to the forge: the server decides what its output leads to, and every forge write
goes through the outbox.

> **Billing warning.** Declaring a plan that includes Fable when yours doesn't can bill
> pay-as-you-go credits without asking. Declare `claude.plan` exactly as your subscription is, and
> leave `claude.fableModel` unset if you are unsure. With `plan: "pro"` (the default) no drop ever
> asks for Fable. Only `max` and `team_premium` count as including Fable.

**Rollback for every stage:** set `crew.enabled: false` on the zone and restart. No crew drop runs,
and nothing is filed, promoted or revised. **Promote** and **Re-stage** rulings are recorded and
apply once the crew is enabled again, provided the issue's body hasn't changed meanwhile. A
**Reject** you rule still applies and closes the issue; a rejection from a refute that finishes
after the switch waits for re-enable. Staged issues never start work. The rest of the zone
keeps working.

## Settings

```json
"crew": {
  "enabled": true,
  "goalPath": "GOAL.md",
  "cycleMinutes": 60,
  "maxDropsPerDay": 24,
  "stagedLabel": "agent-staged",
  "maxStaged": 3,
  "refutePromotes": false,
  "maxRefute": 2
}
```

And at the top level of the server config:

```json
"claude": { "plan": "pro", "fableWeeklyDropCap": 5 }
```

- `goalPath` must match one of the zone's `protectedPaths` (`GOAL.md` is in the defaults); the
  server refuses to start otherwise, so no drop can edit the ladder it is judged against.
- `stagedLabel` must differ from `readyLabel`.
- `maxStaged` caps the zone's open crew issues that aren't promoted, rejected or failed yet,
  including ones waiting to be promoted.
- `maxRefute` caps refute attempts per issue. An attempt counts when the drop is queued, so a
  failed, killed or rate-limited refute uses one up.
- `maxDropsPerDay` counts crew drops (crew-lead, refute, diagnose) over a trailing 24 hours,
  including failed and killed ones but not rate-limited or lost ones.
  Each ruling on a crew briefing starts a new crew-lead cycle, so a busy day can hit the cap; crew
  work then stops until the window rolls.

## Stages

### 1. Prepare

1. Give the author token **Issues: write** on the repository. It files, labels, edits and closes
   crew issues, and reads `GOAL.md` from the default branch.
2. Create the staged label (`agent-staged` by default) and the priority labels a crew issue may
   carry (`highest`, `high`, `low`, `lowest`).
3. For a private repository, set `reviewReadToken: true` on the zone and `JM_GITHUB_READ_TOKEN`
   (read-only). Crew drops clone with it; without it they clone anonymously and fail.
4. Commit `GOAL.md` to the default branch through a normal reviewed PR. Format:
   - `## Lighthouse` (optional): the overall aim.
   - `## Objectives` (required): each objective is a `### ` heading, marked done by ending the
     heading with `(done)`. With no `###` headings, each `- [ ]` / `- [x]` line is an objective.
   - Any other `##` section (Constraints, Non-goals) is passed to the crew as written.
5. Set `claude.plan` (and `fableModel` only if your plan includes Fable). Leave `refutePromotes`
   false.
6. If the zone requires CI (`ciRequired: true`), confirm a runner can pick the required check up.
   A workflow with `runs-on: self-hosted` and no runner stays queued, and the item parks with "no
   CI result: <check> queued and never started". Run a self-hosted runner in a container with no
   host mounts and no Docker socket: it runs code the agent wrote.
7. Enabling the crew first queues one diagnose drop per open parked briefing, one at a time, then
   any pending refutes, then a crew-lead cycle. Rule or clear old parked items first, or expect
   those drops (and Fable use on a Fable plan) before the first cycle. Check with the zone paused:
   `ctl pause <zone>`, set `crew.enabled: true`, restart.

**Pass:** `/zones/<id>/goals` lists every objective with its status and marks the first open one
Current objective (a parse error shows there too). The status page's Crew table lists the zone
with its next cycle and its Fable status (for `pro`: "plan pro does not include Fable"). Then
`ctl resume <zone>`.

### 2. First cycle

The first crew-lead cycle runs after resume, once any diagnose and refute work ahead of it is done.
To ask for another one:

```bash
node apps/server/dist/ctl.js crew-cycle <zone>
```

This marks a cycle due; it runs once the zone is active, the usage gate is open, no other crew drop
is running, the daily cap allows, `GOAL.md` parses, and pending refute or diagnose work is done. `ctl` needs
`JM_OPERATOR_TOKEN` (and `JM_SERVER_URL` if the server isn't on `http://127.0.0.1:7420`).

**Pass:**
- New issues carry the staged label and end with the Jumpmaster marker; each has an outbox row.
- The goals page lists each crew issue with its state and refute findings. Watch stages 2 and 3
  there.
- The crew-lead's stored result (`crewReport` in the drop's result) lists what the server filed and
  what it refused and why: an objective not on the ladder, a duplicate, a bad format, no free
  slot. Many "not on the ladder" refusals mean the objective keys don't match.

A refute drop then judges each staged issue in turn, and decides one of three things:
- **Promote:** a briefing offers **Promote** and **Reject**.
- **Revise:** the issue is edited and judged again, up to `maxRefute`.
- **Reject:** the issue is closed, with no briefing.

When the attempts run out without a verdict, the issue comes to you with **Promote** and
**Reject**. Crew-lead briefings record your choice and start a new cycle; they change nothing else.

### 3. Promote by ruling

Open `/briefings` and rule **Promote** on each refuted issue you agree with, or from a terminal:

```bash
node apps/server/dist/ctl.js rule <briefing> promote "why"
```

**Pass:** the issue loses the staged label, gains the ready label, and goes through the normal
implement, review and merge loop.

- One promoted issue per objective is in flight at a time. The next one waits in `promoting` until
  the earlier one's PR merges. If the earlier one parks or closes, the later ones wait: fix or
  merge it, or reject them.
- Don't edit a crew issue on the forge before promoting it. A changed body stops the promotion and
  raises a briefing with **Re-stage** (take your edit and refute again) or **Reject**.
- A crew issue never starts work until it is promoted, even if someone adds the ready label by
  hand or edits its body: the server starts a crew issue only when its own record says promoted
  and the staged label is gone. Labels and the body can stop a crew issue, never start one. A crew issue that was rejected or failed stays unstartable; the goals page lists it with
  its state. Close it, or file a fresh issue for the work.

### 4. Optional: let refutes promote

Set `refutePromotes: true`. A refute that finds nothing to stop an issue promotes it after a hold of
about a minute, with **Reject** and **Promote now**. Reject still works after promotion until the
work starts. Not part of the M3 gate.

### 5. Diagnose and Fable

When an item parks, the server raises a parked briefing with **Retry**, **Leave parked** and, for a
fully read gate-script or gate-tool park on the current head, **Allow these gate changes for
<sha7>**. The allow option is bound to that head; a later push, even a merge of the base branch,
needs a new ruling. A diagnose drop then reads the branch once per park and adds a **Diagnosis**
and a recommendation to the briefing. They stay until the park's stated reason changes (a new
reason, or a gate park judged on a new head); then they are cleared and the new state is diagnosed
once.

To check the model rules, park something on purpose: add the `jm:hold` label to an in-flight
item's **PR** (the label on the issue does nothing). Then open the diagnose drop at `/drops/<id>`:
- Its requested and served models are shown.
- With `plan: "pro"`, the requested model is never Fable.
- With `max` or `team_premium` and `fableModel` set, diagnose may request Fable, as may any role
  whose model names Fable, until `fableWeeklyDropCap` drops across all zones have asked for it in
  the trailing seven days (drops that started and asked for Fable count, even if they failed or were cancelled). A Fable-only rate limit pauses Fable
  until it resets.

## Kill, pause, observe and restart

- `ctl kill` cancels queued and running crew drops; a cancelled refute or diagnose still used its
  attempt, so a park killed mid-diagnose isn't diagnosed again.
  Nothing is filed, promoted or applied until `ctl unkill`.
- `ctl pause <zone>` stops new drops and forge writes. Rulings still record and apply on
  `ctl resume`. A crew-lead that finishes while paused has its filings refused.
- `ctl observe <zone>` is refused while drops or forge writes are active: `ctl pause <zone>`, wait
  for them to drain, then observe. In observe, crew work is recorded as `would_enqueue:<role>` on `/observations`; no
  drops, no rulings applied, no forge writes.
- A restart never files an issue twice. An intent with no outbox row is filed on the next active
  pass. A write that may have reached the forge is found by its marker, or marked failed after
  `outboxDeadlineMinutes` (defaults to `ciDeadlineMinutes`, 45). A ruling recorded before a restart applies on the next
  active pass; one whose effect failed shows its error in the rulings table and is not retried. A
  `ctl crew-cycle` request does not survive a restart.

## Usage credits

`overageStatus` in a drop's rate-limit event only says whether the account allows extra usage.
When a drop reports `isUsingOverage: true` (it ran on usage credits), Jumpmaster stops starting
new drops in every zone, for every role; running drops finish. A drop's result only backs up its
live events: it never starts a new stop for a drop already seen on credits. The stop lifts by
itself when the exhausted usage window resets (a window at 98% or more; up to seven days for the
weekly window), because work after that runs inside the plan again; the briefing names the window
and why. After it lifts, one drop runs as a probe, and dispatch opens fully once a drop reports
live that it runs in plan, its result says so, or it succeeds without using credits (a failed
probe with no report hands the slot to the next drop); a probe on credits stops again. A
`credits:stop` briefing names the drop, both windows' use and resets, and offers **Run on credits now** and **Noted**. Run on
credits lasts until the five-hour window resets when that is the exhausted window (the time is
shown), otherwise five hours. During that time only the drop's own work item's follow-on drops
(review, heal, resolve) lease; nothing else leases and no new work is queued, so the time idles
until that work is queued (a Resume on a crew drop lets nothing lease). Any other drop on credits
stops dispatch again, and when the time is up one drop probes as above. Set
`usage.stopOnOverage: false` and restart the server to keep the old behaviour (a briefing only);
the config is read once at start, and a stop or probe already recorded then no longer holds. A drop that outlives its lease (a server outage longer than the
lease) is marked lost and its later reports are refused, so credits it used are never seen.

A Fable drop on credits also disables Fable until you rule **Re-enable Fable**. If your plan
doesn't include Fable, set `claude.plan` correctly and restart. `ctl briefings` lists open
briefings with their option ids, so you can rule from a terminal.

## MCP

Jumpmaster can serve a zone-scoped MCP server at `POST /mcp` for Command's own Claude Code. It
reads a zone's state and, with a write token, proposes staged issues and raises briefings through
the same action core as a crew drop. It never merges, reviews, pushes, promotes, rules or edits
`GOAL.md`, and every forge write still goes through the outbox as the author identity.

### Enable

```json
"mcp": {
  "enabled": true,
  "maxBodyBytes": 262144,
  "writesPerHour": 20,
  "callsPerHour": 600,
  "maxOpenBriefings": 5
}
```

The setting is read once at start: **restart the server** after changing it. With
`enabled: false` (the default) `/mcp` and the token routes below are not registered and answer
404. The other fields are optional and default to the values shown.

### Mint, list and revoke tokens

Tokens are issued only by the operator control route; `ctl` never mints or prints one. A token
belongs to one zone and one scope (`read` or `write`), lasts `days` (1 to 90), and is returned
**once**: the server keeps only its SHA-256. Read the operator token from the environment so it
never lands in argv:

```bash
URL=http://127.0.0.1:7420
auth() { printf 'Authorization: Bearer %s\n' "$JM_OPERATOR_TOKEN"; }

# Mint (the response holds the token; store it in a password manager)
auth | curl -sS -H @- -H 'content-type: application/json' \
  -d '{"zoneId":"main","scope":"write","days":30,"label":"laptop"}' "$URL/api/control/mcp-tokens"

# List: id, zone, scope, label, created, expires, last used, revoked. Never the token or hash.
auth | curl -sS -H @- "$URL/api/control/mcp-tokens"

# Revoke by id (takes effect on the next call)
auth | curl -sS -H @- -X DELETE "$URL/api/control/mcp-tokens/3"
```

Mint and revoke are recorded in `mcp_audit` beside every tool call, so a token's whole life is in
one table. A `last used` time you don't recognise means the token is in someone else's hands:
revoke it.

### Connect Claude Code

```bash
claude mcp add --scope user --transport http jumpmaster http://127.0.0.1:7420/mcp \
  --header 'Authorization: Bearer ${JM_MCP_TOKEN}'
```

The single quotes keep `${JM_MCP_TOKEN}` literal: Claude Code stores the reference and expands it
from its environment when it connects, so the token is never in argv, shell history or its
config. Export `JM_MCP_TOKEN` in the environment Claude Code starts from (from a password manager,
not a dotfile in a repository). Use the user scope all the same, so the entry is never in a
project `.mcp.json`. Connect through a host listed in `listen.allowedHosts` (by default `127.0.0.1:<port>`
and `localhost:<port>`). The server is stateless streamable HTTP with JSON responses; a client
must accept both `application/json` and `text/event-stream`, as Claude Code does.

**Rehearsal (test repository):** enable MCP and restart, mint a write token, connect Claude Code,
ask it to read the goals and file one staged issue, and see the issue appear on the goals page
and on the forge under the staged label. Then confirm that a token for another zone cannot see
this zone's items and that a revoked or expired token gets 401.

### What a token can do

- **Read** (`read` and `write` tokens): `get_goals`, `list_work` (titles, states, PRs, park
  reasons; no bodies), `get_work_item` (one issue with its body), `list_briefings`,
  `list_rulings`, `get_queue` (zone mode, kill switch, the global usage gate with any credits
  stop, the zone's queued and active drops and unresolved forge writes). Text from the forge or
  from agents comes fenced and labelled `(data)` or `(data, untrusted)`; your ruling notes and
  `GOAL.md` are labelled `(trusted)`. Jumpmaster op markers are removed and configured secrets
  redacted.
- **Write** (`write` tokens only): `file_staged_issues` (up to 5 issues per call) and
  `raise_briefing` (up to 3 per call, options with no effect). They use the crew's own schema and
  checks: objective on the ladder, agent-ready format, no duplicate, a free `maxStaged` slot, zone
  active, kill switch off. Filed issues wait under the staged label for your **Promote** ruling,
  as crew issues do. Assistant briefings show as "Raised by assistant (MCP)" on `/briefings`,
  under an `mcp:` subject: they can never update a crew or server briefing, and raising one on the
  subject of an open assistant briefing replaces its text.
- **Ruling on an assistant briefing** checks that its options are the ones you read. The page
  sends that for you; from a terminal, take the `optionsDigest` from `ctl briefings` and pass it:
  `ctl rule <briefing> <option> --options <digest> [note]`. If the assistant rewrote the options
  since, the ruling is refused (409 "options changed"): read them again. Every ruling records the
  label and effect you chose.

**Treat a read token like a read PAT.** For a private repository it reads issue titles and bodies,
park reasons (which can quote gate output), briefings with their diagnoses, and your ruling notes.
`get_queue` also shows two global facts on purpose: the usage gate and the kill switch. The plan
tier and Fable status are never shown.

### Refusals

- 401: no token, an unknown, expired (from `expiresAt` on) or revoked token, or a token whose zone
  is no longer in the config. Audited with no token material (see retention below).
- 403: a Host not in `allowedHosts`, or an `Origin` that is `null` or not an allowed host.
- 400 for a JSON-RPC batch; 405 for `GET` or `DELETE /mcp`; 406 when `Accept` lacks either type;
  415 for a non-JSON body; 413 above `maxBodyBytes`. Authentication runs before the body is read.
- Tool calls answer with an error result, audited `refused`, when: the token has made
  `callsPerHour` tool calls of any kind in the past hour (audited once per hour, not per call); a
  read token calls a write tool; the arguments fail the schema; the zone's crew is disabled
  (`raise_briefing` only: `file_staged_issues` works with the crew off); a usage credits stop is in
  force; the arguments contain a token or a configured secret; the token has made
  `writesPerHour` write calls in the past hour; or the zone already holds `maxOpenBriefings` open
  assistant briefings. In pause, observe or kill the action core refuses each item with the mode.
- The audit stores tool, token, zone, a SHA-256 of the arguments, the outcome and a reason code or
  counts, never the text you sent. A failure inside the server answers a bare JSON-RPC
  "internal error", audited `error`, and the call records nothing.
- Retention, swept at most once a minute: rows older than 90 days go, then the newest 100,000 are
  kept; refused logins keep the newest 500 anonymous rows and, separately, the newest 500 that name
  a token (an expired or revoked token in use). Mint and revoke rows are kept.

Issues filed over MCP are filed under the staged label whether the crew is on or off, and start
nothing until you rule. With the crew on, its refute judges each one and then briefs you. With the
crew off, the server raises the Promote briefing itself on its next pass (once per issue, with the
same Promote and Reject options), and a Promote ruling applies at once: the issue gets the ready
label and starts like any promoted crew issue. If the issue was edited on GitHub meanwhile, a
Re-stage ruling (which also applies with the crew off) takes the edited text and earns a fresh
Promote briefing; if it was closed, nothing is promoted and a briefing says so. `crew.goalPath`
must match a `protectedPaths` glob in every zone, crew on or off (`GOAL.md` is protected by
default), because the file is read every pass and served as your own text. `GOAL.md` is read on every pass whenever `crew.goalPath` is set (it is by default),
crew on or off, so `get_goals` works before you ever enable the crew.

### Intake skills

Three Claude Code skills walk you from a repository to a merged `GOAL.md` and the first staged
issues over this MCP server, with a write token for the zone:

- [`jumpmaster-intake-existing`](../../skills/jumpmaster-intake-existing/SKILL.md): an existing
  codebase;
- [`jumpmaster-intake-idea`](../../skills/jumpmaster-intake-idea/SKILL.md): a new project from an
  idea;
- [`jumpmaster-intake-partial`](../../skills/jumpmaster-intake-partial/SKILL.md): a partly built
  project.

They share one flow, in [`skills/shared`](../../skills/shared/interviewer.md): check the connection
with `get_queue`, interview you one question at a time, read the repository as data, write
`GOAL.md` on a local branch for you to merge by pull request (it is a protected path), then file
at most five issues with `file_staged_issues`. Those wait under the staged label for your
**Promote** ruling, like any crew issue. The skills hold no forge token and never label, promote
or merge anything.

Install them as user skills, keeping the layout (each skill links `../shared`):

```bash
mkdir -p ~/.claude/skills
cp -R skills/jumpmaster-intake-existing skills/jumpmaster-intake-idea \
  skills/jumpmaster-intake-partial skills/shared ~/.claude/skills/
```

Then, in a checkout of the zone's repository, ask Claude Code to run the one that fits. None of
it needs the crew on: each filed issue gets a Promote briefing on `/briefings`, and your Promote
ruling starts it. Enabling the crew is a separate, later choice that spends usage (its own cycles
start then).
For a quick first issue without the crew, the in-app intake page (`/zones/<id>/intake`) files one
ready issue directly.
