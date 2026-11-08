# Runbook: M3 crew

The crew reads the objective ladder in `GOAL.md`, files candidate issues under a staged label, tries
to refute each one, and raises briefings. Command (you) rules on those briefings in the UI. Nothing a
crew drop does reaches the forge directly: the server decides, and every forge write goes through
the outbox.

> **Billing warning.** Declaring a plan that includes Fable when yours doesn't can bill
> pay-as-you-go credits without asking. Declare `claude.plan` exactly as your subscription is, and
> leave `claude.fableModel` unset if you are unsure. With `plan: "pro"` (the default) no drop ever
> asks for Fable.

**Rollback for every stage:** set `crew.enabled: false` on the zone and restart the server. Crew
issues stay staged, nothing is promoted, and the rest of the zone keeps working.

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

- `goalPath` must match one of the zone's `protectedPaths`; the server refuses to start otherwise,
  so no drop can edit the ladder it is judged against.
- `stagedLabel` must differ from `readyLabel`. A staged issue never starts work, even if someone
  adds the ready label by hand: the server checks its own record of the issue, not the labels.
- `maxStaged` caps open staged issues per zone. `maxRefute` caps refute attempts per issue; an issue
  that exhausts them gets a briefing instead of another attempt.
- Promotions are serialized per objective: while one promoted issue of an objective is unmerged, the
  next promoted issue waits in `promoting`.

## Stages

### 1. Prepare

1. Give the author token **Issues: write** on the repository (it files and labels staged issues).
2. Create the staged label (`agent-staged` by default) on the repository.
3. Commit `GOAL.md` to the default branch, through a normal reviewed PR. It holds objectives as
   `## ` headings with checkbox lines under them, plus optional Constraints and Non-goals sections.
   Open `/zones/<id>/goals` in the UI and confirm every objective and checkbox appears.
4. Set `claude.plan` (and `fableModel` only if your plan includes Fable). Leave `refutePromotes`
   false.
5. If the zone requires CI (`ciRequired: true`), confirm a runner can actually pick the required
   check up. A workflow that asks for `runs-on: self-hosted` with no runner registered stays queued
   forever, and the item parks with "no CI result". Keep a self-hosted runner in a container with
   no host mounts and no Docker socket: it runs code the agent wrote.

**Pass:** the goals page shows the ladder; the status page's Crew table lists the zone with its
next cycle due and its Fable status.

### 2. First cycle

Run one cycle now instead of waiting for `cycleMinutes`:

```bash
node apps/server/dist/ctl.js crew-cycle <zone>
```

**Pass:**
- The crew-lead drop's payload carries no write token (only the read token, if one is set).
- Each new issue carries the staged label and the Jumpmaster marker, and has a matching outbox row.
- The crew-lead's `refused` list (ideas it chose not to file) is plausible.
- A refute drop runs for each staged issue. When it finds a criterion that doesn't hold, the issue
  is revised and refuted again (up to `maxRefute`); when it can't refute it, a briefing offers
  **Promote** and **Reject**.

### 3. Promote by ruling

Open `/briefings` and rule **Promote** on each refuted issue you agree with. The same ruling from a
terminal:

```bash
node apps/server/dist/ctl.js rule <briefing> promote "why"
```

**Pass:** the issue loses the staged label, gains the ready label, and goes through the normal
implement, review and merge loop. Only one promoted issue per objective is in flight at a time.

### 4. Optional: let refutes promote

Set `refutePromotes: true`. A refute that finds no reason to stop the issue promotes it, but holds
it for one pass with a **Reject** option first. Not part of the M3 gate.

### 5. Diagnose and Fable

When an item parks, a diagnose drop reads its branch and raises a briefing with a `Diagnosis:` note
and options: **Retry**, **Leave parked**, and, for a fully read gate-script or gate-tool park,
**Allow these gate changes for <sha7>**. The allow option is bound to the head SHA it was offered
for; a later push needs a new ruling.

To check the model rules, park something on purpose (add `jm:hold` to an in-flight issue) and read
the diagnose drop's record:
- `requested` and `served` model are both recorded.
- With `plan: "pro"`, the requested model is never Fable and the status page says why.
- With a plan that includes Fable and `fableModel` set, diagnose may request Fable until
  `fableWeeklyDropCap` drops have used it in the trailing seven days.

## Kill, pause and restart

- `ctl kill` stops crew drops like any other; staged issues stay staged.
- `ctl pause <zone>` stops new cycles and new drops; rulings still record.
- A restart between filing intent and issue creation leaves one outbox row, which the next pass
  sends once. A restart between a ruling and its effect re-applies the ruling idempotently.

## Rate limits

The usage gate reads `rate_limit_event` from every drop. When a drop reports `isUsingOverage`,
Jumpmaster raises a `credits_required` briefing naming the drop and its `overageStatus`; if that
drop asked for Fable, Fable is disabled until you rule **Re-enable Fable**. Jumpmaster never buys
credits. If you see this briefing and expected no overage, set `claude.plan` to `pro` and restart.
