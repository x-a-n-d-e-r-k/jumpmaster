# Spike: Claude usage signals under a setup-token

Status: procedure written; results TO BE FILLED BY OPERATOR.

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

Run date: TO BE FILLED BY OPERATOR
Claude Code version (`claude --version` in the image): TO BE FILLED BY OPERATOR
Plan type (e.g. Pro, Max): TO BE FILLED BY OPERATOR

### (a) `rate_limit_event`

Appears: TO BE FILLED BY OPERATOR (yes / no / only sometimes)

Fields observed: TO BE FILLED BY OPERATOR

Redacted example:

```json
TO BE FILLED BY OPERATOR
```

### (b) Result message

`usage`:

```json
TO BE FILLED BY OPERATOR
```

`modelUsage`:

```json
TO BE FILLED BY OPERATOR
```

`terminal_reason`: TO BE FILLED BY OPERATOR

Other notable fields: TO BE FILLED BY OPERATOR

### (c) `/usage` report

Readable with a setup-token: TO BE FILLED BY OPERATOR (yes / `rate_limits` is null / error)

Detail: TO BE FILLED BY OPERATOR

### Behaviour at the limit (optional)

TO BE FILLED BY OPERATOR

## Conclusion for M1 usage-pause design

Which signal(s) the M1 usage pause can rely on: TO BE FILLED BY OPERATOR

Gaps and fallbacks: TO BE FILLED BY OPERATOR
