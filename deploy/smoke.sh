#!/usr/bin/env bash
# Runtime smoke test of the compose install, in an empty directory, as the host user, with dummy
# tokens (nothing real is read or sent).
#
#   deploy/smoke.sh                          the template plus the from-source override
#                                            (deploy/compose.build.yaml) on the :dev images
#                                            images.yml builds; what CI runs
#   deploy/smoke.sh --release vX.Y.Z         the published release's compose.yaml, as a user runs
#                                            it: signed-policy stick, empty JM_ALLOWED_IMAGES, the
#                                            release's egress digest, a server carrying the lock
#   deploy/smoke.sh --release <lock.json>    the same, rendering this checkout's template with an
#                                            image lock (registry and digests) instead
#
# Checks:
#   - `init` runs as the host user with the install directory read-write, refuses uid 0, reports a
#     refused author token without printing it, and (offline, starter) writes the config, the
#     generated secrets (0600) and its .env lines; the reviewer token file is then not needed;
#   - `up` starts the server as the host user (database under ./data) and the stick, which enrolls
#     over the compose network with the join token from a file;
#   - `docker compose exec jumpmaster jumpmaster ctl …` reaches the server, the doctor included,
#     and the doctor sees the secret files as 0600 (config.secret-files);
#   - release mode: the stick runs the signed policy with image-verify-v1, and the doctor's
#     stick.image-policy passes;
#   - no secret value appears in any output or log.
# JM_SMOKE_ONLINE=1 also requires GitHub's own 401 for the dummy token (needs api.github.com).
# Prints one line per check; exits non-zero on the first failure.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE=dev
RELEASE=""
if [ "${1:-}" = "--release" ]; then
  MODE=release
  RELEASE="${2:?usage: deploy/smoke.sh [--release vX.Y.Z|lock.json]}"
  if [ -f "$RELEASE" ]; then RELEASE="$(cd "$(dirname "$RELEASE")" && pwd)/$(basename "$RELEASE")"; fi
fi
WORK="$(mktemp -d)"
PROJECT="jm-compose-smoke-$$"
if [ "$MODE" = dev ]; then
  export JM_SOURCE="$ROOT"
  C=(docker compose -p "$PROJECT" --project-directory "$WORK"
    -f "$ROOT/deploy/compose.yaml.tmpl" -f "$ROOT/deploy/compose.build.yaml")
else
  C=(docker compose -p "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yaml")
fi
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
SECRETS='SMOKE'
no_secret() { if grep -qE "$SECRETS" <<<"$1"; then fail "a secret value appears in $2"; fi; }
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
owner_of() { stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"; }

echo "compose smoke ($MODE${RELEASE:+ $RELEASE}): Compose $(docker compose version --short), Docker Engine $(docker version --format '{{.Server.Version}}')"
cd "$WORK"
if [ "$MODE" = release ]; then
  if [ -f "$RELEASE" ]; then
    node "$ROOT/scripts/render-compose.ts" "$ROOT/deploy/compose.yaml.tmpl" "$RELEASE" >compose.yaml \
      || fail "render the template with $RELEASE"
  else
    for f in compose.yaml images.lock.json SHA256SUMS; do
      curl -fsSLO "https://github.com/x-a-n-d-e-r-k/jumpmaster/releases/download/$RELEASE/$f" || fail "download $f for $RELEASE"
    done
    (sha256sum -c SHA256SUMS 2>/dev/null || shasum -a 256 -c SHA256SUMS) >/dev/null || fail "SHA256SUMS does not match"
  fi
  grep -q 'JM_IMAGE_POLICY: signed' compose.yaml || fail "the compose file's stick is not signed"
  grep -qE 'JM_EGRESS_IMAGE: "?[^"]*@sha256:[0-9a-f]{64}' compose.yaml \
    || fail "the compose file's JM_EGRESS_IMAGE is not a digest"
  echo "release compose.yaml: signed stick, egress image by digest: ok"
fi
printf 'JM_UID=%s\nJM_GID=%s\n' "$(id -u)" "$(id -g)" >.env
mkdir -m 0700 secrets
put() { printf '%s\n' "$2" >"secrets/$1" && chmod 0600 "secrets/$1"; }
put claude_token sk-ant-oat01-SMOKEDUMMYSMOKEDUMMY
put github_author_token github_pat_SMOKEAUTHORDUMMY
put github_reviewer_token github_pat_SMOKEREVIEWERDUMMY
"${C[@]}" config --quiet || fail "compose config"
echo "compose config with .env: ok"

# init: as root it refuses; as the host user it reaches GitHub, which refuses the dummy token.
set +e
out="$("${C[@]}" --profile init run --rm --user 0:0 init --repo octo/demo 2>&1)"
code=$?
set -e
[ "$code" = 1 ] && grep -q 'refusing to run as root' <<<"$out" || fail "init as root: $code $out"
echo "init as uid 0 refused: ok"
set +e
out="$("${C[@]}" --profile init run --rm init --repo octo/demo 2>&1)"
code=$?
set -e
no_secret "$out" "init output"
[ "$code" = 1 ] || fail "init with a dummy token exited $code: $out"
[ ! -e config/jumpmaster.config.json ] || fail "init wrote a config after a refusal"
if grep -q 'rejected the author token (401)' <<<"$out"; then
  echo "init as the host user: GitHub refused the dummy token (401), reported without its value: ok"
elif [ "${JM_SMOKE_ONLINE:-}" = 1 ]; then
  fail "JM_SMOKE_ONLINE=1, but init did not get GitHub's 401: $out"
else
  grep -q 'could not read octo/demo' <<<"$out" || fail "init did not report the refusal: $out"
  echo "init as the host user: GitHub not reachable from here, reported without the token: ok (401 path not exercised)"
fi

# init's write path, in the container: offline, starter mode, so no reviewer token is needed.
rm secrets/github_reviewer_token
set +e
out="$("${C[@]}" --profile init run --rm init --repo octo/demo --offline --preset node --identity starter 2>&1)"
code=$?
set -e
no_secret "$out" "init output"
[ "$code" = 0 ] || fail "offline init exited $code: $out"
[ -f config/jumpmaster.config.json ] || fail "offline init wrote no config"
for f in join_token operator_token; do
  [ "$(mode_of "secrets/$f")" = 600 ] || fail "secrets/$f is mode $(mode_of "secrets/$f")"
  [ "$(owner_of "secrets/$f")" = "$(id -u)" ] || fail "secrets/$f is not owned by $(id -u)"
done
grep -qx 'JM_REVIEWER_TOKEN_SRC=/dev/null' .env || fail ".env lacks init's starter lines: $(cat .env)"
SECRETS="SMOKE|$(cat secrets/join_token)|$(cat secrets/operator_token)"
echo "init (offline, starter) in the container: config, 0600 secrets owned by the host user, .env lines: ok"

# Observe mode, so nothing is dispatched against the dummy repository. The dev images are :dev
# tags, which a signed install refuses.
sed -i.bak 's/"crew": {/"mode": "observe", "crew": {/' config/jumpmaster.config.json
[ "$MODE" = dev ] && sed -i.bak 's/"requireSignedImages": true/"requireSignedImages": false/' config/jumpmaster.config.json
rm -f config/jumpmaster.config.json.bak
"${C[@]}" up -d jumpmaster stick >/dev/null 2>&1 || fail "compose up"
for _ in $(seq 60); do
  "${C[@]}" logs jumpmaster 2>&1 | grep -q 'listening on 0.0.0.0:7420' && break
  sleep 1
done
"${C[@]}" logs jumpmaster 2>&1 | grep -q 'listening on 0.0.0.0:7420' || fail "server did not start"
[ -f data/jumpmaster.sqlite ] || fail "no database under ./data"
[ "$(owner_of data/jumpmaster.sqlite)" = "$(id -u)" ] || fail "the database is not owned by $(id -u)"
echo "server: host uid, database under ./data, file secrets, no reviewer token: ok"
for _ in $(seq 60); do
  "${C[@]}" logs stick 2>&1 | grep -q 'enrolled as' && break
  sleep 1
done
"${C[@]}" logs stick 2>&1 | grep -q 'enrolled as' || fail "stick did not enroll"
echo "stick: enrolled with the join token file over the compose network: ok"
if [ "$MODE" = release ]; then
  "${C[@]}" logs stick 2>&1 | grep -qE 'image policy signed, capabilities .*image-verify-v1' \
    || fail "the stick does not run the signed policy with image-verify-v1"
  echo "stick: signed policy, image-verify-v1: ok"
fi

out="$("${C[@]}" exec -T jumpmaster jumpmaster ctl briefings)" || fail "ctl briefings: $out"
case "$out" in 200*) ;; *) fail "ctl briefings answered: $out" ;; esac
set +e
out="$("${C[@]}" exec -T jumpmaster jumpmaster ctl doctor 2>&1)"
set -e
no_secret "$out" "doctor output"
grep -q 'config.uid' <<<"$out" || fail "the doctor did not run: $out"
grep -qE '^PASS .*config\.secret-files' <<<"$out" || fail "config.secret-files did not pass: $out"
if [ "$MODE" = release ]; then
  grep -qE '^PASS .*stick\.image-policy' <<<"$out" || fail "stick.image-policy did not pass: $out"
fi
echo "docker compose exec jumpmaster jumpmaster ctl (briefings, doctor; secret files 0600): ok"

no_secret "$("${C[@]}" logs 2>&1)" "the logs"
echo "no secret value in any log: ok"
echo "compose smoke ($MODE): pass"
