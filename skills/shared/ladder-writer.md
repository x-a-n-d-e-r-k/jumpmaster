# Ladder writer

How an intake skill turns the interview into `GOAL.md`, the objective ladder Jumpmaster's crew
reads. `GOAL.md` is a protected path: no agent may change it, so Command merges it by hand.

## The format

Jumpmaster parses `GOAL.md` with a line scanner. Keep to this shape exactly:

- `## Lighthouse`: a short paragraph, what the project is for.
- `## Objectives`: one `- [ ]` line per objective, in order. The first unchecked one is the
  **current objective**: crew work and new issues aim at it. A finished objective becomes
  `- [x]`. Indented lines under an item are its notes.
- Any other `##` section (`## Non-goals`, `## Constraints`, …) is kept as context.
- No `#` heading, list item or code fence inside the Lighthouse paragraph: it would move the
  section boundaries.

## Example

```markdown
# Goal

## Lighthouse

A command-line tool that turns a folder of CSV exports into one tidy monthly report, for a
small team that does its bookkeeping by hand today.

## Objectives

- [ ] The tool reads every CSV in a folder and reports rows it can't parse
  Start with the bank export format in the samples folder.
- [ ] Totals per category and per month, matching the hand-made report for March
- [ ] A Markdown report written next to the input folder
- [ ] Packaged as a single command with a --help that explains every option

## Non-goals

- A web interface.
- Talking to any bank directly.

## Constraints

- No new runtime dependency without Command's approval.
- Every change keeps npm test and npm run lint green.
```

Each objective is an outcome a person can check, not a task list. Keep objectives to five or
fewer; the rest can wait in Non-goals or come later.

## Writing it

1. Show Command the full draft and ask for corrections. Repeat until they say it is right.
2. Create a **local branch** (for example `goal/first-ladder`), write `GOAL.md` at the
   repository root (or at the zone's `crew.goalPath` if Command set another), and commit it with
   a plain message such as "Add the goal ladder".
3. Push the branch and tell Command to **open a pull request and merge it themselves**. Never
   push to the default branch and never merge: the merge is Command's review of the ladder.
4. Wait until Command says it is merged. Then check `mcp__jumpmaster__get_goals`: the ladder
   appears there once Jumpmaster has read the default branch (the crew must be enabled for the
   zone; see [the issue splitter](issue-splitter.md)). If it reports a parse error, fix the file
   on a new branch the same way.
