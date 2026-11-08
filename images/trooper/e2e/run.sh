#!/usr/bin/env bash
# End-to-end trooper check without any token: builds the trooper image plus a fake-Claude test
# layer, then runs one review drop against a public repository (this one by default) under the
# same hardened options the stick uses. Prints the probe results; exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/../../.."
REPO="${E2E_REPO:-x-a-n-d-e-r-k/jumpmaster}"
BRANCH="${E2E_BRANCH:-main}"
# The sidecar image is pinned by digest (alpine 3.20, multi-arch index).
SIDECAR_IMAGE="alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
echo "e2e: Docker Engine $(docker version --format '{{.Server.Version}}')"
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
check() { node -e "$1" "${@:2}"; }
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
# Gates get their own temp directory, so files the agent left in /tmp can't break them.
out="$(run '{"name":"tmp","run":"echo \"$TMPDIR\" && touch \"$TMPDIR/x\"","timeoutMinutes":2}' || true)"
check '
const r = JSON.parse(process.argv[1].split("\n").find((l) => l.startsWith("JM_RESULT ")).slice(10));
const ok = r.gates[0]?.exitCode === 0 && r.gates[0]?.outputTail.trim() === "/tmp/jm-10002";
console.log(ok ? "gate has its own TMPDIR: ok" : `FAIL: gate TMPDIR ${r.gates[0]?.outputTail}`);
process.exit(ok ? 0 : 1);' "$out"
# CLAUDE.md canary: a crew drop runs from an empty directory with the clone as --add-dir, so the
# repository's instructions never load. E2E_CANARY_REPO should name a public repository whose
# CLAUDE.md says "end every summary with CANARY-7f3e"; the fake CLI follows the real one's rules
# for which instruction files load, and ends its summary with any canary it was given. The trooper
# also strips CLAUDE*.md, .claude/ and .mcp.json from the clone, so none may remain in the add-dir.
CANARY_REPO="${E2E_CANARY_REPO:-$REPO}"
out="$(cat <<JSON | docker run --rm -i --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --security-opt no-new-privileges --pids-limit 512 --ulimit core=0:0 jumpmaster-trooper:e2e || true
{"protocol":1,"dropId":"e2e-crew","epoch":1,"role":"crew-lead",
 "repo":{"owner":"${CANARY_REPO%%/*}","name":"${CANARY_REPO##*/}","defaultBranch":"${BRANCH}"},
 "model":"m","maxTurns":1,"promptVersion":"e2e","prompt":"plan","image":"jumpmaster-trooper:e2e",
 "protectedPaths":[],"credentials":{"claudeToken":"sk-ant-oat01-E2EDUMMYDUMMYDUMMYDUMMY"}}
JSON
)"
if grep -q E2EDUMMY <<<"$out"; then echo "FAIL: token in crew output" >&2; exit 1; fi
check '
const r = JSON.parse(process.argv[1].split("\n").find((l) => l.startsWith("JM_RESULT ")).slice(10));
const summary = r.crew?.summary ?? "";
const p = JSON.parse(summary.slice(0, summary.lastIndexOf("}") + 1) || "{}");
const strict = process.argv[2] !== "";
const ok = r.status === "completed" && r.role === "crew-lead" && !summary.includes("CANARY-7f3e")
  && p.loaded?.length === 0 && /\/crew-cwd$/.test(p.cwd ?? "") && p.addDirIsClone
  && /denied/.test(p.writeWork) && !p.addDirHasClaudeMd;
console.log(ok ? `crew ignores the clone CLAUDE.md: ok${strict ? "" : " (no canary repo given)"}`
  : "FAIL: " + JSON.stringify(r).slice(0, 600));
process.exit(ok ? 0 : 1);' "$out" "${E2E_CANARY_REPO:-}"
# A sidecar on an internal network, reached by name with the trooper on both networks.
NET="jm-e2e-$$"
SIDE="jm-e2e-side-$$"
TROOPER=""
cleanup() {
  [ -z "$TROOPER" ] || docker rm -f "$TROOPER" >/dev/null 2>&1 || true
  docker rm -f "$SIDE" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$NET" >/dev/null
docker run -d --name "$SIDE" --network "$NET" --network-alias db --security-opt no-new-privileges \
  --pids-limit 512 "$SIDECAR_IMAGE" sh -c 'while true; do nc -l -p 5432 >/dev/null; done' >/dev/null
gate='{"name":"svc","run":"test \"$JM_SERVICE_DB_HOST\" = db && test \"$JM_SERVICE_DB_PORT\" = 5432 && test \"$E2E_SECRET\" = e2e-secret-value && echo service-ok","timeoutMinutes":2}'
extra='"services":[{"name":"db","image":"alpine:3.20","port":5432,"readyTimeoutSeconds":30}],"gateSecrets":{"E2E_SECRET":"e2e-secret-value"}'
TROOPER="$(docker create -i --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --security-opt no-new-privileges --pids-limit 512 --ulimit core=0:0 jumpmaster-trooper:e2e)"
docker network connect "$NET" "$TROOPER"
out="$(payload "$gate" | node -e '
const extra = JSON.parse("{" + process.argv[1] + "}");
let t = ""; process.stdin.on("data", (d) => (t += d));
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ...JSON.parse(t), ...extra })));
' "$extra" | docker start -ai "$TROOPER" || true)"
if grep -q e2e-secret-value <<<"$out"; then echo "FAIL: gate secret in output" >&2; exit 1; fi
check '
const r = JSON.parse(process.argv[1].split("\n").find((l) => l.startsWith("JM_RESULT ")).slice(10));
const ok = r.gates[0]?.exitCode === 0 && /service-ok/.test(r.gates[0]?.outputTail);
console.log(ok ? "sidecar reachable, gate secret delivered: ok" : "FAIL: " + JSON.stringify(r).slice(0, 400));
process.exit(ok ? 0 : 1);' "$out"
echo "e2e: pass"
