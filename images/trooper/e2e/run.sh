#!/usr/bin/env bash
# End-to-end trooper check without any token: builds the trooper image plus a fake-Claude test
# layer, then runs one review drop against a public repository (this one by default) under the
# same hardened options the stick uses. Prints the probe results; exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/../../.."
REPO="${E2E_REPO:-x-a-n-d-e-r-k/jumpmaster}"
BRANCH="${E2E_BRANCH:-main}"
SHA="$(git ls-remote "https://github.com/${REPO}.git" "refs/heads/${BRANCH}" | cut -f1)"
[ -n "$SHA" ] || { echo "cannot resolve ${REPO}@${BRANCH}" >&2; exit 1; }
docker build -q -t jumpmaster-trooper:dev -f images/trooper/Dockerfile . >/dev/null
docker build -q -t jumpmaster-trooper:e2e images/trooper/e2e >/dev/null
payload() {
  cat <<JSON
{"protocol":1,"dropId":"e2e","epoch":1,"role":"review",
 "repo":{"owner":"${REPO%%/*}","name":"${REPO##*/}","defaultBranch":"${BRANCH}"},
 "issue":{"number":1,"title":"e2e","body":"e2e"},"branch":"${BRANCH}",
 "pr":{"number":1,"branch":"${BRANCH}","headSha":"${SHA}"},
 "gates":[$1],"model":"m","maxTurns":1,"promptVersion":"e2e","prompt":"review",
 "image":"jumpmaster-trooper:e2e","protectedPaths":[],
 "credentials":{"claudeToken":"sk-ant-oat01-E2EDUMMYDUMMYDUMMYDUMMY"}}
JSON
}
run() {
  payload "$1" | docker run --rm -i --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL \
    --security-opt no-new-privileges --pids-limit 512 --ulimit core=0:0 jumpmaster-trooper:e2e
}
check() { node -e "$1" "$2"; }
out="$(run '{"name":"uid","run":"id -u","timeoutMinutes":2}' || true)"
if grep -q E2EDUMMY <<<"$out"; then echo "FAIL: token in output" >&2; exit 1; fi
check '
const line = process.argv[1].split("\n").find((l) => l.startsWith("JM_RESULT "));
if (!line) { console.error("FAIL: no result"); process.exit(1); }
const r = JSON.parse(line.slice(10));
const p = r.verdict ? JSON.parse(r.verdict.summary) : {};
const ok = r.status === "completed" && r.gates[0]?.outputTail.trim() === "10002" && p.uid === "10001"
  && p.tokenPresent && /denied/.test(p.readGateHome) && /denied/.test(p.readProc1Environ)
  && /denied/.test(p.writeWork) && p.systemPromptReadable;
console.log(JSON.stringify({ status: r.status, reason: r.reason, gateUid: r.gates[0]?.outputTail.trim(), ...p }, null, 1));
process.exit(ok ? 0 : 1);' "$out"
out="$(run '{"name":"creds","run":"cat /home/agent/.claude/.credentials.json","timeoutMinutes":2}' || true)"
check '
const r = JSON.parse(process.argv[1].split("\n").find((l) => l.startsWith("JM_RESULT ")).slice(10));
const ok = r.verdict?.decision === "request_changes" && /Permission denied/.test(r.gates[0]?.outputTail ?? "");
console.log(ok ? "gate cannot read agent credentials: ok" : "FAIL: gate read agent credentials");
process.exit(ok ? 0 : 1);' "$out"
echo "e2e: pass"
