# Runbook: the M4.5 gate

M4.5 (Operable) passes when two design partners who have never opened a Jumpmaster config file
each complete the [operability session](operate.md#the-operability-session) with the browser as
their only interface after `docker compose up`, and meet the bar below. This runbook is for the
person running the gate (the **author**). The partner gets one page: the operability session.

M4's partner session is run with the same sheet and counters, and its numbers are the report's
"Before (M4)" column. Run it first, or the report has nothing to compare against.

## What the author provides

The only inputs, ready before the partner sits down:

- **A supported host:** Linux with a rootful Docker Engine, or macOS with Docker Desktop. It has an
  empty directory and `cosign`. Note its OS and `docker version`.
- **A published full release.** The README's prelude downloads from `releases/latest`, which skips
  prereleases. With only a release candidate out, the prelude as written fails; don't edit it for
  the partner.
- **Two fresh test repositories**, each with a small seed app and CI, and **no** ruleset,
  CODEOWNERS or labels. A rerun uses a fresh pair.
- **The bot accounts**, with their collaborator invitations accepted, and their tokens. Also a
  second author token, made in advance for step 5. A real user would make it from the template
  link; the owner dry run exercised that link.
- **The partner's own Claude token**, from `claude setup-token`, run by the partner.
- **The public repository URL**, where the README is.
- **A screen recording** of the partner's screen, and a stopwatch.

## Roles

The **partner** works from the operability session alone. The **author** times, injects the fail at
step 7, asks the two status questions, and records. The author answers a question only when the
partner cannot proceed without the answer (a **blocking** question). Every question and every
hesitation over a minute is recorded, with what the partner was looking for.

## Two clocks

- **The prelude:** the README's commands, copied without edits, up to and including
  `docker compose up`. Count the commands and the minutes.
- **The session** starts when the setup page appears. The author's stopwatch counts the partner's
  **hands-on** time and is paused while CI or a drop runs.

The two shell steps excluded by design are the prelude and `claude setup-token`.

## The session

Each step names what is measured or asserted. The steps follow the operability session.

1. **Claim it.** Enter the setup code and choose a passphrase. *Measure:* the time until the
   passphrase is set.
2. **Set it up.** In the wizard:
   - connect the Claude token and the forge tokens, following the identity recommendation;
   - add the first repository;
   - import the ruleset file;
   - commit CODEOWNERS from the generated text;
   - create the labels from the doctor;
   - run the doctor.

   *Measure:* the time to a doctor with no fail. Record every fail seen, and whether its link was
   followed.
3. **First issue.** File it from Intake and wait for its pull request to merge. *Measure:* the time
   to merge, which is excluded from hands-on time. **Status question 1** is asked while this step
   waits on CI.
4. **Change a running zone.** Pause the zone. **Status question 2** is asked here. Then change a
   gate's timeout in Stack, and resume. *Assert:* the next drop runs with the new timeout, with no
   restart (see [Reading the stick's drop-start line](#reading-the-sticks-drop-start-line)).
5. **Rotate a token.** In Settings, Credentials, replace the author token with the second one.
   Revoke the old one on GitHub once the page no longer says a running drop carries it. *Assert:*
   - the settings row shows the new date and fingerprint;
   - the next drop's `forgeToken` equals the new fingerprint;
   - that drop's pull request is pushed and opened. It could not be with the revoked token.
6. **A second repository.** Add it, import its ruleset file, create its labels, and run the doctor.
   *Measure:* the time to a doctor with no fail.
7. **Recover.** The author deletes the `agent-ready` label on the second repository and asks the
   partner to run the doctor. *Assert:* the partner reaches the fix through `forge.labels`'s action,
   and the doctor shows no fail again.
8. **Read the status line.** Ask the two status questions at the moments set in steps 3 and 4:
   "What is Jumpmaster doing, and why is it waiting?" *Assert:* each answer matches the status line
   at the top of home, in the partner's own words. Write down both the answer and the line.

### Reading the stick's drop-start line

These are the author's checks, not the partner's, so they don't count as the partner's shell
commands. At the start of each drop, the stick logs one JSON line:

```sh
docker compose logs stick | grep '"event":"drop-start"' | tail -1
```

```json
{"event":"drop-start","dropId":"…","role":"implement","gates":[{"name":"test","timeoutMinutes":7}],"forgeToken":"1a2b3c4d"}
```

- `timeoutMinutes` is the gate's timeout as this drop received it (step 4).
- `forgeToken` is the first 8 hex characters of the SHA-256 of the token the drop carries. That is
  the same form Settings, Credentials shows. A crew or doctor drop carries no forge token and has
  no `forgeToken` field.

## Counted per partner

- prelude commands and minutes;
- edits to any file after `docker compose up`;
- shell commands beyond `docker compose up` and `docker compose logs`;
- questions, split into blocking and other;
- hesitations over a minute;
- hands-on minutes.

## The bar

Per partner, all of these:

- the prelude in at most 6 commands and 10 minutes;
- zero file edits after `docker compose up`;
- zero shell commands after `docker compose up` (`logs` allowed);
- zero blocking questions, with every question and hesitation reported;
- under 60 minutes hands-on;
- every assertion in steps 4, 5, 7 and 8 holds.

## The sheet

One per partner. Fill in "Before (M4)" from M4's session, run with this sheet. M4 has no
operability steps, so leave a row blank where it doesn't apply.

| | Before (M4) | After (M4.5) |
|---|---|---|
| Host OS and Docker version | | |
| Prelude: commands / minutes | | |
| Step 1: minutes to passphrase | | |
| Step 2: minutes to a doctor with no fail | | |
| Step 2: fails seen (check id, link followed?) | | |
| Step 3: minutes to merge (excluded) | | |
| Step 4: new timeout in drop-start, no restart | | |
| Step 5: new fingerprint in drop-start, PR pushed | | |
| Step 6: minutes to a doctor with no fail | | |
| Step 7: reached the fix through the action | | |
| Step 8: answers vs the status line | | |
| File edits after `up` | | |
| Shell commands after `up` (beyond `logs`) | | |
| Questions: blocking / other | | |
| Hesitations over a minute | | |
| Hands-on minutes | | |

Attach the screen recording. For each question and each hesitation, give a line saying what the
partner was looking for and where they found it.

## Fixes and reruns

Each of these becomes a test-first fix or a runbook edit:
- a blocking question;
- a hesitation over a minute;
- a doctor result that was wrong;
- a gap in the docs.

After a fix, the same partner may rerun on a fresh repository pair. That run counts only for the
step the fix addressed.

If M4.5 shipped in two parts, the M4.5a gate is steps 1–3 and 7, and the M4.5b gate is steps 4–6
and 8. Each part needs both partners, with the same counters and the same bar.

## The report

For the owner: each partner's sheet beside M4's baseline, every fix with its rerun, and a line per
bar item saying whether it was met.
