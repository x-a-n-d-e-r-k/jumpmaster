# Spike: Claude usage signals under a setup-token

Status: run on 2026-10-19; results below.

Purpose: find out which usage and rate-limit signals Claude Code exposes when it
authenticates with a long-lived `setup-token` (not an API key). The findings decide
the M1 usage-pause design (spec section 12.3).

## Prerequisites

- Docker running locally.
- The trooper image built: `docker build -t jumpmaster-trooper:dev -f images/trooper/Dockerfile .`
- A token from `claude setup-token`, held in your shell environment only.

## Handling the token

- Never write the token to a file, a script, or a command line. Do not paste it into
  a command (it would land in shell history).
- Set it for the current shell session only, by reading it silently. In bash or zsh:

  ```sh
  read -rs CLAUDE_CODE_OAUTH_TOKEN && export CLAUDE_CODE_OAUTH_TOKEN
  ```

  (In fish: `read -s -x CLAUDE_CODE_OAUTH_TOKEN`.)
- The commands below use `-e CLAUDE_CODE_OAUTH_TOKEN` with no value, so Docker copies
  the variable from your environment and the value never appears in the process list
  or history.
- When finished, run `unset CLAUDE_CODE_OAUTH_TOKEN`.

## Procedure

Work in a scratch directory outside the repository so raw output cannot be committed
by accident.

The commands below are bash/zsh. In fish, replace `mkdir -p "$(mktemp -d)/spike" && cd "$_"`
with `set d (mktemp -d)/spike; mkdir -p $d; and cd $d` (fish has no `$_`); the
`docker run` lines work unchanged.

### 1. One tiny headless run

```sh
mkdir -p "$(mktemp -d)/spike" && cd "$_"
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN --entrypoint claude \
  jumpmaster-trooper:dev \
  -p "Reply with the single word: pong" \
  --output-format stream-json --verbose --max-turns 1 \
  > run1.jsonl
```

The image's entrypoint is the trooper; `--entrypoint claude` runs the installed
Claude Code CLI directly instead. Each line of `run1.jsonl` is one JSON message.

### 2. Inspect the output

```sh
# message types seen, with counts
node -e 'const l=require("fs").readFileSync("run1.jsonl","utf8").trim().split("\n").map(JSON.parse);
const c={};for(const m of l){const k=m.type+(m.subtype?":"+m.subtype:"");c[k]=(c[k]||0)+1}console.log(c)'

# any rate_limit_event, in full
grep '"rate_limit_event"' run1.jsonl

# the final result message
grep '"type":"result"' run1.jsonl | tail -n 1
```

Record:

- (a) Whether `rate_limit_event` appears at all, and if so which fields
  `rate_limit_info` carries (status, reset time, window/type, utilization, overage).
  Note whether it appears on every run or only near a limit. Run the command two or
  three times to see if it varies.
- (b) On the result message: the `usage` object, the `modelUsage` object, and
  `terminal_reason` (also `subtype`, `is_error`, `num_turns`, `total_cost_usd`).
- (c) Whether the `/usage` report (`SDKUsageReport.rate_limits`) is readable with a
  setup-token, or is `null`. Try:

  ```sh
  docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN --entrypoint claude \
    jumpmaster-trooper:dev -p "/usage" --output-format json
  ```

  If that slash command is not available headless, note that, and record how else
  (if at all) the report can be reached. Record the exact outcome, including
  `null`, an auth error, or a populated `rate_limits`.

### 3. Optional: observe behaviour at the limit

If the account is at or near a usage limit, repeat step 1 and record what appears
(the `rate_limit_event` status, `terminal_reason`, error text, exit code). Do not
burn quota deliberately to provoke this.

## Redaction before committing

Raw output can contain account identifiers and, in error paths, credentials.

1. Remove or replace every token value. Nothing starting with `sk-ant-` may remain.
2. Remove email addresses, organisation or account IDs, and session IDs.
3. Check before you commit:

   ```sh
   grep -nE 'sk-ant-|ghp_|github_pat_|oauth' docs/spikes/usage-signals.md
   ```

   Review any hits by hand. Paste only trimmed, redacted JSON excerpts below, never
   whole transcripts. Do not commit `run1.jsonl`.

## Results

Run date: 2026-10-19
Claude Code version (`claude --version` in the image): 2.1.302
Plan type: a personal subscription via `claude setup-token` (tier not recorded)

### (a) `rate_limit_event`

Appears: **yes, on every run** (3 of 3 headless runs, including the real M0 drop), as
one message between the assistant output and the result, even at low utilization.

Fields observed in `rate_limit_info`:

- `status` (`allowed` in every run)
- `resetsAt` (epoch seconds) and `rateLimitType` (`five_hour`) for the binding window
- `overageStatus`, `overageResetsAt`, `isUsingOverage`
- `unifiedWindows`: **both** windows with utilization, so the weekly window is visible
  too, not only the 5-hour one

Redacted example:

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1792442400,
    "rateLimitType": "five_hour",
    "overageStatus": "allowed",
    "overageResetsAt": 1793491200,
    "isUsingOverage": false,
    "unifiedWindows": {
      "five_hour": { "utilization": 0.02, "resetsAt": 1792442400 },
      "seven_day": { "utilization": 0.15, "resetsAt": 1792555200 }
    }
  },
  "uuid": "<redacted>",
  "session_id": "<redacted>"
}
```

### (b) Result message

`usage` (trimmed):

```json
{
  "input_tokens": 2,
  "cache_creation_input_tokens": 5426,
  "cache_read_input_tokens": 11228,
  "output_tokens": 4,
  "output_tokens_details": { "thinking_tokens": 0 },
  "service_tier": "standard",
  "speed": "standard"
}
```

`modelUsage` (keyed by model; trimmed):

```json
{
  "claude-sonnet-5-5": {
    "inputTokens": 2,
    "outputTokens": 4,
    "cacheReadInputTokens": 11228,
    "cacheCreationInputTokens": 5426,
    "costUSD": 0.0228708,
    "contextWindow": 1000000,
    "canonicalModel": "claude-sonnet-5-5",
    "costBasis": "list"
  }
}
```

`terminal_reason`: `completed`

Other notable fields: `subtype: "success"`, `is_error: false`, `num_turns`,
`total_cost_usd` (list-price estimate, not a bill), `api_error_status`,
`permission_denials`, `stop_reason`, and timing (`duration_ms`, `duration_api_ms`,
`ttft_ms`). With no `--model`, the CLI default was `claude-sonnet-5-5`; the drop config
sets the model explicitly, so drops are unaffected.

### (c) `/usage` report

Readable with a setup-token: **not as rate limits.** `claude -p "/usage" --output-format json`
succeeds, but `result` is a local session summary (cost, durations, code changes, token
counts, all zero for a fresh session) and the message carries no `rate_limits` field.
There is no headless way to read remaining quota on demand; the only source is the
`rate_limit_event` that each run emits.

### Behaviour at the limit (optional)

Not observed: utilization was about 2% of the 5-hour window and 15% of the weekly window.
Not provoked deliberately.

## Conclusion for M1 usage-pause design

Which signal(s) the M1 usage pause can rely on:

- `rate_limit_event.rate_limit_info` on every run. `status` drives the decision
  (`allowed_warning` → soft throttle, `rejected` → global pause), and `resetsAt` gives
  the resume time.
- `unifiedWindows.{five_hour,seven_day}.utilization` allows a **proactive** throttle
  before a limit is hit (for example, stop starting new drops above a configurable
  utilization), and shows weekly exhaustion distinctly from the 5-hour window.
- `modelUsage` per drop for per-project usage accounting and budgets (spec §5.3).

Gaps and fallbacks:

- No on-demand quota query, so state is only as fresh as the last drop. When idle, the
  scheduler should run a cheap probe drop before resuming after a pause.
- `rejected` behaviour and fields at the limit are still unobserved; M1 must also
  handle `api_error_status` / `is_error` on the result and an assistant `rate_limit`
  error, and stay correct if `unifiedWindows` is absent.
- The trooper's parser already normalizes `status`/`resetsAt`. M1 should also keep
  `rateLimitType` and `unifiedWindows` instead of reading only the raw event.
