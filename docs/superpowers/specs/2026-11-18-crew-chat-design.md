# Crew chat: steer the factory from the app

Epic #336. Status: design, for the owner's approval.

## Intent

Jumpmaster is a product people download, install and leave building their software. The owner still has to steer it: notice it is idle, decide what is next, change the goals, talk a design through, file the work, rule on what the crew asks. Today that steering happens outside the product, in the owner's own Claude Code session connected to the repository and the server. A friend who installs Jumpmaster has no such session, and should not need one.

The crew chat is that session, inside the app. The owner talks to it the way they talk to Claude Code today, and it does what they agree to. It is where the owner's judgment enters the factory, not a help panel.

## Goals

- A conversation that can carry the discussions an owner has today in Claude Code: "why is it idle?", "what's left?", "why is #252 stuck?", working through a design, "file it", "change the goal", "work on #178 next".
- It knows the whole install: every zone's goals, objectives, issues, pull requests, briefings, drops and crew trail, the sticks, the settings, and each zone's code at the latest default branch.
- It acts when the owner agrees in the conversation, and shows each action as it happens.
- Nothing outside the app is needed to steer: no Claude Desktop, no `jumpmaster ctl`, no GitHub for routine steering.

## Non-goals

- Replacing the crew lead's scheduled cycle. The crew keeps planning and filing on its own; the chat is the owner's channel into it.
- Writing code. The chat files and shapes work; troopers implement it.
- Multi-user chat. One owner per install, as today.

## Anti-goals (it fails if…)

- …a guarded safeguard can be loosened through the chat without the same confirmation the browser asks for.
- …text the chat reads (an issue, a comment, a file in the repository) can make it act.
- …it acts between the owner's messages, on its own initiative.
- …setup gets harder: an owner who has finished setup today must get a working chat with no new step.

## Constraints (from the code today)

- The central server never starts containers; only the stick mounts the Docker socket (`deploy/compose.yaml.tmpl`).
- The install has one Claude credential, `claudeToken`, resolved by the server (env, secrets dir, then vault) and handed to drops in their payload (`payloads.ts`). Sticks hold no token of their own.
- Usage is tracked install-wide (`usage_state`, `usage_windows`) from drops' rate-limit events through `ingestRateLimit` (`usage.ts`).
- The config store asks for confirmation (409) and refuses browser-forbidden paths (403) only for `via: 'session'`; a `token` principal skips both (`config/store.ts`).
- MCP tokens are per zone, read or write (`mcp/tokens.ts`). There are six read tools and two write tools (`file_staged_issues`, `raise_briefing`).
- `control_audit.via` is `token | session | system`; there is no actor beyond that.
- GOAL.md is a protected path: no agent pushes it and the push container refuses it.

## Approaches

**A. A chat service beside the server, running Claude Code** (chosen). A new always-on compose service runs Claude Code headless, with a clone of every zone's repository (pulled before reading) and Jumpmaster's MCP server as its only way to act. It holds no GitHub write credential. It reuses the agent harness the troopers run, its long-conversation handling, and skills.

**B. The server calls the Claude API directly with a small tool set.** Lighter (no container), but the agent loop, context management and code search would be rebuilt by hand, and design discussions would be weak. Rejected: it fails the main goal.

**C. The server holds the conversation and sends code questions to sticks as drops.** Rejected by the owner: replies would wait for a free trooper and count against the drop limit.

Owner decisions: runs on the server, not a stick; approach A; repositories cloned in the chat service and pulled when needed; the same Claude token as the sticks; acts on the owner's word; one chat for the whole install, with threads.

## Design

### The chat service

- A new compose service, `chat`, in `deploy/compose.yaml.tmpl` and the installers. It is built from the trooper image (Claude Code is already in it) or a sibling image released and signed the same way.
- Hardening as the `jumpmaster` service: read-only root, `cap_drop: ALL`, no Docker socket, reachable only on the compose network. Writable volumes: `chat-repos` (the clones) and `chat-sessions` (Claude Code's session files).
- Egress: the Anthropic API and the forge only, enforced the way the stick enforces a drop's egress.
- It holds no secrets at rest. For each turn, the server sends it the Claude token and a short-lived chat MCP token, in the turn's process environment and nowhere else.
- **Repository credentials never reach the model's process** (my call). Before a turn, the service fetches the zones it needs with the zone's read credential: the reviewer app's short-lived token for app zones, or `githubReadToken` for PAT zones. It passes the credential through a one-shot git credential helper, so it never lands in `.git/config` or on a volume. The `claude` process gets no GitHub credential.
- One turn = one `claude -p … --resume <session>` process with `--output-format stream-json`, the MCP config pointing at the server's `/mcp`, and tools limited to reading the clones (Read, Grep, Glob, read-only `git`) plus the MCP tools. No web access, no file writes outside the clones' `.git` metadata.
- Before a turn reads a zone, the service fetches its default branch (shallow, then deepened as needed).

### Server side

- **Threads.** New tables `chat_threads` (id, title, focus zone or none, created, updated, Claude session id) and `chat_messages` (thread, role, text, action cards, usage, at). The server is the record; the service's session files are only a cache, and a lost cache starts the thread over from a server-written summary.
- **A turn.** `POST /api/chat/threads/:id/messages` stores the owner's message, checks the usage gate (`dispatchGate`; a stopped gate refuses with the reason), sends the turn to the service, and relays its stream to the browser (server-sent events). Each rate-limit event goes to `ingestRateLimit` with a source whose `dropId` is `chat:<thread>:<n>` (never a real drop id), so the factory's pace accounts for chat use.
- **One turn at a time per thread**; a second message waits. Threads run in parallel up to a small cap (builder's call).

### What the chat can do

- **A chat MCP scope.** A new token kind, `chat`, minted per turn and expiring with it. It is install-wide: every tool takes a `zoneId`, checked against the zones that exist. It is never shown to the owner or exportable.
- **Read tools**: the existing six, plus sticks and their state, settings (with the catalog's plain words, #321), the doctor's last run, open issues and PRs per zone (including those with no Jumpmaster label), and drop transcripts.
- **Action tools** (all new except the first two):
  - file staged issues; raise a briefing (existing);
  - queue a backlog issue (put the zone's ready label on it);
  - rule a briefing (any option the owner names, through `ruleBriefing`);
  - change a setting, zone or install (through `ConfigStore.apply`);
  - pause, resume, run a crew cycle, retry a parked item;
  - mark an objective done;
  - propose a goal change (below);
  - close an issue.
- **Which identity writes, and what text it writes** (my call). Labels and closes go through the author identity, the way the server already labels. They carry no text. Issues the chat files are staged crew issues on the existing path, so they still pass the crew's refute before any trooper works them. There is no tool for comments or free-form issue text: anything the factory treats as trusted input reaches it only through the crew's existing pipeline, never straight from the model.
- **Every action is the owner's word** (owner decision: trust the instructions, within server limits).
  - The chat's instructions say to act only on what the owner agreed to in this thread, and to treat everything it reads as data. If something it reads asks it to act, it says so and doesn't act.
  - Text it reads from issues, comments, PRs, drop output and the repository is wrapped in the troopers' `jm-data` markers.
  - The server doesn't check each action against the conversation. Its limits are these:
    - the chat MCP token exists only while a turn the owner's message started is running;
    - every action is carded, with Undo where possible;
    - guarded changes need the browser confirmation;
    - there are no free-text writes to the forge.
- **Guards hold.** Chat actions reach the config store as a new principal, `via: 'chat'`, treated exactly like `session`. A guarded change returns the pending confirmation, and the chat shows it as a card with **Confirm**, which opens today's confirmation page (passphrase). A browser-forbidden path is refused, and the card says to use `jumpmaster ctl` or the config file.
- **Audit.** `control_audit.via` gains `chat`, and `detail` carries the thread and message ids. `mcp_audit` rows for chat tokens carry the same.
- **Cards.** Every action shows in the thread as a card: what was done, a link (the issue, the PR, the setting row) and, where it can be reversed, **Undo**. The cards come from the server's record of the action, not from the model's text.
- **What Undo does** (my call):
  - A label comes off, and a closed issue is reopened.
  - A setting change is undone by the inverse patch of just that change, applied through the config store like any other change. It doesn't roll back the whole revision. If the undo would loosen a guard, it asks for confirmation like any other change.
  - Rulings have no Undo. A ruling is what the owner said, and the next pass applies it within seconds.

### Goal changes (spec §8.1)

The chat edits GOAL.md by proposing a change. The server, not the push container, commits it on a branch through the forge API as the author identity, and opens a PR. The card shows the diff, with **Approve and merge**, which goes through the confirmation page because GOAL.md is a protected path. On confirmation, the reviewer identity approves it, and the flow merges it the same way it merges agent PRs (my call). So whatever the zone's branch rules allow for agent PRs works here too, and the doctor already checks those rules. The flow's protected-path refusal gets one narrow exception: a PR the server itself opened as a goal change, whose head SHA matches the one the owner confirmed. This is the only path that writes GOAL.md, and only after the owner's confirmation in the browser.

The crew lead can propose a goal change too (my call): its briefing carries the proposed GOAL.md text, and a new effect, `open_goal_change`, has the server open the PR when the owner rules on it. The PR then needs the same confirmation to merge.

### The page

- `/chat` lists threads, newest first, and opens one. A **Chat** link goes in the top bar on every page.
- From a zone page, a briefing or a goals page, **Ask about this** opens a new thread focused on that object. Its first turn is given the object's context (the briefing's item, drops, verdicts and diff, for #103).
- Messages stream in. Tool calls show as one collapsed line each ("read apps/server/src/goals.ts", "listed jm's open issues"), and actions as cards.

### Setup

No new step. The chat uses the install's `claudeToken` and its read credential (`githubReadToken`, or the reviewer app's read token for app zones). The doctor gains a check: the chat service is up and can reach both. An install without the chat service (an older compose file) shows the chat page with the one command that adds it.

## Slices, in order (my call)

1. **Backlog queue.** The zone page lists open issues with no Jumpmaster label, with **Work on it** (puts the ready label on). It needs no chat and unblocks an idle zone now.
2. **Chat service and read-only threads.** The compose service, the turn API, threads, streaming, the read tools, usage accounting. It answers questions and can't act yet.
3. **Actions.** The chat scope's action tools, `via: 'chat'`, cards, undo, audit.
4. **Ask about this.** Focused threads from zones, goals and briefings (#103).
5. **Goal changes.** The goal-change PR, its confirmation and merge.

## Left to the builder

- Image (trooper image or a sibling), the stream relay mechanics, the thread cap, how cards are rendered, summary-on-cache-loss wording, which skills ship in the chat service and how they are pinned.
- Exact tool names and argument shapes, following the existing MCP tools.
