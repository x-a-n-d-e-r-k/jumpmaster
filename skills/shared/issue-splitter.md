# Issue splitter

How an intake skill turns the current objective into its first issues and proposes them to
Jumpmaster. Proposals are **staged**: nothing starts until Command promotes each one by a ruling.

## Before filing

- `GOAL.md` is merged and `mcp__jumpmaster__get_goals` shows it parsed (see
  [the ladder writer](ladder-writer.md)). Use the objective **key** it reports (a slug of the
  objective's text, at most 60 characters), not the title.
- The crew does not need to be on. `mcp__jumpmaster__file_staged_issues` works with the zone's
  crew off: the issues are filed under the staged label and nothing starts.

## Splitting

- Aim every issue at the **current objective** only. Later objectives get issues when they
  become current.
- One issue is one pull request an agent can finish in a sitting: a few files, one behaviour,
  with its tests. Split anything bigger.
- Order them so each builds on the last. Propose at most **five** at a time; the zone's
  `crew.maxStaged` may allow fewer, and a refused proposal says why.
- Each issue stands alone: an agent reading it sees only the issue, so name the files, commands
  and behaviour it needs.

## The issue template

Every body uses exactly these sections, in this order:

```markdown
## Context

What exists today, what is missing, and why this issue matters for the current objective. Name
the files and functions involved.

## Acceptance criteria

- [ ] One observable behaviour per line, checkable by a person or a test
- [ ] Another behaviour

## Required tests

- The tests that must exist and pass, by file or by name

## Out of scope

- What this issue must not change
```

The title is one line of at most 120 characters, an imperative ("Report unparsable CSV rows").
The key is lowercase letters, digits and hyphens, at most 40 characters, unique in the zone (for
example `report-bad-csv-rows`). Priority is optional: `highest`, `high`, `low` or `lowest`.

## Filing

1. Show Command every proposed issue in full and ask for corrections.
2. Call `mcp__jumpmaster__file_staged_issues` once with the list (`key`, `objective`, `title`,
   `body`, optional `priority`). Report what it filed and, for each refusal, its reason.
3. Tell Command what happens next: each filed issue waits on the forge under the staged label,
   and nothing starts until Command rules. Each gets a briefing on the Briefings page of the
   Jumpmaster web UI: with the zone's crew off, the server puts it there on its next pass; with the
   crew on, the crew judges the issue first and then puts it there. Command reads the issue and
   should rule **Promote** on its briefing in the web UI to let an agent start, or **Reject** to
   close it. Turning the crew on is a separate, later choice for Command, which spends usage
   (the crew then runs its own cycles, bounded by `crew.cycleMinutes` and `crew.maxDropsPerDay`);
   this flow doesn't need it. You never promote, label or merge anything yourself, and you never
   use a forge command line for it.
