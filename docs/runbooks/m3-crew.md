# Runbook: M3 crew

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
- `maxDropsPerDay` counts every crew drop (crew-lead, refute, diagnose) over a trailing 24 hours.
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
7. Enabling the crew starts a crew-lead cycle on the next pass, so check first with the zone
   paused: `ctl pause <zone>`, set `crew.enabled: true`, restart.

**Pass:** `/zones/<id>/goals` lists every objective with its status and marks the first open one
Current objective (a parse error shows there too). The status page's Crew table lists the zone
with its next cycle and its Fable status (for `pro`: "plan pro does not include Fable"). Then
`ctl resume <zone>`.

### 2. First cycle

The first cycle runs on the next pass after resume. To ask for another one:

```bash
node apps/server/dist/ctl.js crew-cycle <zone>
```

This marks a cycle due; it runs once the zone is active, the usage gate is open, no other crew drop
is running, the daily cap allows, and pending refute or diagnose work is done. `ctl` needs
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
  hand or edits its body: the server checks its own record of the issue, not the labels or the
  body. A crew issue that was rejected or failed stays unstartable; the goals page lists it with
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
and a recommendation to the briefing. They stay until what they diagnosed changes (a new park
reason, or the same park on a new head); then they are cleared and the new state is diagnosed once.

To check the model rules, park something on purpose: add the `jm:hold` label to an in-flight
item's **PR** (the label on the issue does nothing). Then open the diagnose drop at `/drops/<id>`:
- Its requested and served models are shown.
- With `plan: "pro"`, the requested model is never Fable.
- With `max` or `team_premium` and `fableModel` set, diagnose may request Fable, as may any role
  whose model names Fable, until `fableWeeklyDropCap` drops across all zones have asked for it in
  the trailing seven days (failed and cancelled drops count). A Fable-only rate limit pauses Fable
  until it resets.

## Kill, pause, observe and restart

- `ctl kill` cancels queued and running crew drops; a cancelled refute or diagnose still used its
  attempt, so a park killed mid-diagnose isn't diagnosed again. Nothing is filed, promoted or applied until `ctl unkill`.
- `ctl pause <zone>` stops new drops and forge writes. Rulings still record and apply on
  `ctl resume`. A crew-lead that finishes while paused has its filings refused.
- `ctl observe <zone>`: crew work is recorded as `would_enqueue:<role>` on `/observations`; no
  drops, no rulings applied, no forge writes.
- A restart never files an issue twice. An intent with no outbox row is filed on the next active
  pass. A write that may have reached the forge is found by its marker, or marked failed after
  `outboxDeadlineMinutes` (45 by default). A ruling recorded before a restart applies on the next
  active pass; one whose effect failed shows its error in the rulings table and is not retried. A
  `ctl crew-cycle` request does not survive a restart.

## Usage credits

When a drop reports that it ran on usage credits (`isUsingOverage: true` in its rate-limit event;
`overageStatus` only says whether the account allows extra usage), Jumpmaster raises a
`credits_required` briefing naming the drop. It does not yet stop dispatch, so later drops may also
run on credits. To stop spending, `ctl pause <zone>` (or `ctl kill`) and turn off extra usage on
the Claude account. If a Fable drop caused it on a plan without Fable, also set `claude.plan`
correctly and restart; Fable stays disabled until you rule **Re-enable Fable**.
