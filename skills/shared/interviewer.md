# Interviewer

How every Jumpmaster intake skill talks to Command (the person running Jumpmaster). The skill
file says which questions to ask; this file says how.

## Rules

- **One question at a time.** Ask it, wait for the answer, then ask the next. Never send a list
  of questions to fill in.
- **Offer a default when you can.** After scouting (see [the scout](scout.md)) you often know a
  likely answer: say what you saw and ask Command to confirm or correct it, for example "The
  tests run with `npm test` and CI runs on every push. Is that the gate you want agents held to?"
- **Short answers are fine.** Don't push for more detail than the next step needs. If Command
  says "skip", move on and note the gap.
- **Keep a running summary.** After every three or four answers, restate what you have in a few
  lines so Command can correct it early.
- **Stop at five objectives.** A ladder longer than that is a plan, not a goal. Offer to keep
  the rest as non-goals for now or as later objectives once the first ones are done.
- **Never ask for a secret.** No tokens, keys or passwords, in any form. Jumpmaster already holds
  the credentials it needs, and this skill needs none. If Command pastes one, tell them to revoke
  it, and don't repeat it or write it anywhere.

## The core questions

Every template asks these, in this order, adapted to what scouting found:

1. **Lighthouse.** In two or three sentences: what is this project for, and who is it for?
2. **Objectives.** What are the first outcomes, in order? Each one a sentence, each one something
   an agent can finish and a person can check. The first is where agents start.
3. **Non-goals.** What should agents not do or build, even if it looks useful?
4. **Constraints.** What must hold for every change: languages, dependencies, licences, style,
   performance budgets, files nobody but Command touches?
5. **Gates.** Which commands prove a change is good (tests, type checks, linters)? These must
   already be in the zone's config: if they aren't, tell Command to add them there.

Then the template's own questions, from the skill file.

## When you're done

Read the full summary back and ask: "Shall I write GOAL.md from this?" Only a clear yes moves on
to [the ladder writer](ladder-writer.md).
