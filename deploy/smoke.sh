#!/usr/bin/env bash
# Runtime smoke test of the compose install, without any real token: the release template plus
# the from-source override (deploy/compose.build.yaml), in an empty directory, as the host user.
# Expects the :dev images images.yml builds (server, stick, egress). Checks:
#   - `init` runs as the host user with the install directory read-write, refuses uid 0, and
#     reports a refused author token by status without printing it;
#   - `up` starts the server as the host user (database under ./data) and the stick, which enrolls
#     over the compose network with the join token from a file;
#   - `docker compose exec jumpmaster jumpmaster ctl …` reaches the server, the doctor included;
#   - no secret value appears in any output or log.
# Prints one line per check; exits non-zero on the first failure.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
PROJECT="jm-compose-smoke-$$"
export JM_SOURCE="$ROOT"
C=(docker compose -p "$PROJECT" --project-directory "$WORK"
  -f "$ROOT/deploy/compose.yaml.tmpl" -f "$ROOT/deploy/compose.build.yaml")
cleanup() {
  "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*" >&2
  "${C[@]}" logs --tail 20 >&2 2>&1 || true
  exit 1
}
SECRETS='SMOKE|smoke-join-token|smoke-operator-token'
no_secret() { if grep -qE "$SECRETS" <<<"$1"; then fail "a secret value appears in $2"; fi; }

echo "compose smoke: $(docker compose version --short), Docker Engine $(docker version --format '{{.Server.Version}}')"
cd "$WORK"
printf 'JM_UID=%s\nJM_GID=%s\n' "$(id -u)" "$(id -g)" >.env
mkdir -m 0700 secrets
put() { printf '%s\n' "$2" >"secrets/$1" && chmod 0600 "secrets/$1"; }
put claude_token sk-ant-oat01-SMOKEDUMMYSMOKEDUMMY
put github_author_token github_pat_SMOKEAUTHORDUMMY
put github_reviewer_token github_pat_SMOKEREVIEWERDUMMY
"${C[@]}" config --quiet || fail "compose config"
echo "compose config with .env, the template and the from-source override: ok"

# init: as root it refuses; as the host user it reaches GitHub, which refuses the dummy token.
set +e
out="$("${C[@]}" --profile init run --rm --user 0:0 init --repo octo/demo 2>&1)"
code=$?
set -e
[ "$code" = 1 ] && grep -q 'refusing to run as uid 0' <<<"$out" || fail "init as root: $code $out"
echo "init as uid 0 refused: ok"
set +e
out="$("${C[@]}" --profile init run --rm init --repo octo/demo 2>&1)"
code=$?
set -e
no_secret "$out" "init output"
[ "$code" = 1 ] || fail "init with a dummy token exited $code: $out"
grep -qE 'rejected the author token \(401\)|could not read octo/demo' <<<"$out" \
  || fail "init did not report the refused token: $out"
[ ! -e config/jumpmaster.config.json ] || fail "init wrote a config after a refusal"
echo "init as the host user, install dir read-write, refused token reported without its value: ok"

# What init writes after a successful run, by hand: an observe-mode zone that runs no drop.
mkdir -p config data
put join_token smoke-join-token-0123456789
put operator_token smoke-operator-token-0123456789abcdef
cat >config/jumpmaster.config.json <<'JSON'
{
  "listen": { "host": "0.0.0.0", "port": 7420, "allowedHosts": ["127.0.0.1:7420", "localhost:7420"] },
  "dataDir": "/data",
  "pollSeconds": 3600,
  "dropZones": [
    { "id": "demo", "repo": "octo/demo", "mode": "observe", "preset": "node",
      "gates": [{ "name": "test", "run": "true" }] }
  ]
}
JSON
"${C[@]}" up -d jumpmaster stick >/dev/null 2>&1 || fail "compose up"
for _ in $(seq 60); do
  "${C[@]}" logs jumpmaster 2>&1 | grep -q 'listening on 0.0.0.0:7420' && break
  sleep 1
done
"${C[@]}" logs jumpmaster 2>&1 | grep -q 'listening on 0.0.0.0:7420' || fail "server did not start"
[ -f data/jumpmaster.sqlite ] || fail "no database under ./data"
owner="$(stat -c '%u' data/jumpmaster.sqlite 2>/dev/null || stat -f '%u' data/jumpmaster.sqlite)"
[ "$owner" = "$(id -u)" ] || fail "the database is owned by uid $owner, not $(id -u)"
echo "server: host uid, database under ./data, file secrets: ok"
for _ in $(seq 60); do
  "${C[@]}" logs stick 2>&1 | grep -q 'enrolled as' && break
  sleep 1
done
"${C[@]}" logs stick 2>&1 | grep -q 'enrolled as' || fail "stick did not enroll"
echo "stick: enrolled with the join token file over the compose network: ok"

out="$("${C[@]}" exec -T jumpmaster jumpmaster ctl briefings)" || fail "ctl briefings: $out"
case "$out" in 200*) ;; *) fail "ctl briefings answered: $out" ;; esac
set +e
out="$("${C[@]}" exec -T jumpmaster jumpmaster ctl doctor 2>&1)"
set -e
grep -q 'config.uid' <<<"$out" || fail "the doctor did not run: $out"
no_secret "$out" "doctor output"
echo "docker compose exec jumpmaster jumpmaster ctl (briefings, doctor): ok"

no_secret "$("${C[@]}" logs 2>&1)" "the logs"
echo "no secret value in any log: ok"
echo "compose smoke: pass"
