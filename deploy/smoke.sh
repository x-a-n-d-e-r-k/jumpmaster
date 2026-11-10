#!/usr/bin/env bash
# Runtime smoke test of the compose install, each case in its own empty directory, as the host
# user, with dummy tokens (nothing real is read or sent).
#
#   deploy/smoke.sh [--case NAME]            the template plus the from-source override
#                                            (deploy/compose.build.yaml) on the :dev images
#                                            images.yml builds; what CI runs (every case)
#   deploy/smoke.sh --release vX.Y.Z         the published release's compose.yaml, as a user runs
#                                            it: signed-policy stick, empty JM_ALLOWED_IMAGES, the
#                                            release's egress digest, a server carrying the lock
#   deploy/smoke.sh --release <lock.json>    the same, rendering this checkout's template with an
#                                            image lock (registry and digests) instead
#
# Cases (default: all of them, in this order; deploy/deploy.test.ts runs each with JM_SMOKE=1):
#   init        `init` refuses uid 0 and reports a refused author token without printing it; offline
#               and starter it writes the config and, through bootstrap, the machine secrets (0600),
#               and nothing into .env; `up` then serves file mode, the doctor's secret-file check
#               sees real modes, and `ctl` reaches the server
#   env-only    a directory holding only .env
#   empty       an empty directory: on a uid-1000 host (or Docker Desktop, whose file sharing maps
#               every owner) `up` alone; elsewhere bootstrap stops with the .env line, which is run
#   root-owned  secrets/, data/ and config/ made by root: the first `up` (with `sudo` where it needs no
#               password) stops in bootstrap with the chown line; that command is run, and the
#               second `up` reaches the setup page. Skipped, by name, on an engine that reports
#               every file as owned by its reader (Docker Desktop's file sharing)
#   upgrade     an M4 install: init's files under the frozen M4 compose (deploy/fixtures), its .env
#               block and a leftover reviewer token beside a starter zone, run once; then compose.yaml
#               is replaced and `up` again: every credential resolves as a file by name, no zone is
#               parked, the data is kept
#   roundtrip   the upgrade, then `ctl config adopt`, the host export line and `ctl config mode file`
#               (`all` runs it after the upgrade, on the same install)
# Every case but init ends with: the setup code once on the server's own line, GET /setup 200 on
# 127.0.0.1:7420, the stick enrolled, and `ctl passphrase set` ending setup mode. No secret value
# appears in any output or log. Waits poll the server over HTTP and fail with its log tail.
#
# JM_SMOKE_WORK_ROOT: where the case directories go (default $TMPDIR, else /tmp).
# JM_SMOKE_ONLINE=1 also requires GitHub's own 401 for the dummy token (needs api.github.com).
# Prints one line per check; exits non-zero on the first failure.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE=dev
RELEASE=""
CASE=all
while [ $# -gt 0 ]; do
  case "$1" in
    --release)
      MODE=release
      RELEASE="${2:?usage: deploy/smoke.sh [--release vX.Y.Z|lock.json] [--case NAME]}"
      if [ -f "$RELEASE" ]; then RELEASE="$(cd "$(dirname "$RELEASE")" && pwd)/$(basename "$RELEASE")"; fi
      shift 2
      ;;
    --case)
      CASE="${2:?usage: deploy/smoke.sh [--release vX.Y.Z|lock.json] [--case NAME]}"
      shift 2
      ;;
    *)
      echo "usage: deploy/smoke.sh [--release vX.Y.Z|lock.json] [--case init|env-only|empty|root-owned|upgrade|roundtrip]" >&2
      exit 2
      ;;
  esac
done
case "$CASE" in
  all | init | env-only | empty | root-owned | upgrade | roundtrip) ;;
  *)
    echo "unknown case $CASE" >&2
    exit 2
    ;;
esac
# The physical path: Docker Desktop binds a not-yet-existing subdirectory of the /var/folders
# symlink path (macOS's $TMPDIR) to an empty directory of its own, not the one bootstrap then makes.
WORK_ROOT="$(cd "${JM_SMOKE_WORK_ROOT:-${TMPDIR:-/tmp}}" && pwd -P)"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
# What the server's healthcheck and a browser reach: the published loopback port.
URL=http://127.0.0.1:7420
PASSPHRASE='smoke operator passphrase SMOKEPASS'
SECRETS='SMOKE'
RELDIR=""
WORK=""
C=()

mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
owner_of() { stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"; }
no_secret() { if grep -qE "$SECRETS" <<<"$1"; then fail "a secret value appears in $2"; fi; }
fail() {
  echo "FAIL: $*" >&2
  if [ ${#C[@]} -gt 0 ]; then
    for s in bootstrap jumpmaster stick; do
      echo "--- $s (last 30 lines)" >&2
      "${C[@]}" logs --no-log-prefix --tail 30 "$s" 2>&1 | grep -vE "$SECRETS" >&2 || true
    done
  fi
  exit 1
}
# The case's directory and anything root left in it: root-owned leftovers go through a root
# container with just the capabilities a removal needs.
cleanup_case() {
  [ -n "$WORK" ] || return 0
  if [ ${#C[@]} -gt 0 ]; then
    "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    "${C[@]}" run --rm --no-deps --user 0:0 --cap-add DAC_OVERRIDE --cap-add FOWNER \
      --entrypoint rm bootstrap -rf /install/secrets /install/data /install/config \
      /install/.probe >/dev/null 2>&1 || true
    "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  cd /
  rm -rf "$WORK" 2>/dev/null || true
  WORK=""
  C=()
}
trap 'cleanup_case; [ -z "$RELDIR" ] || rm -rf "$RELDIR"' EXIT

echo "compose smoke ($MODE${RELEASE:+ $RELEASE}, case $CASE): Compose $(docker compose version --short), Docker Engine $(docker version --format '{{.Server.Version}}')"

# Release files, fetched and verified once; every case copies compose.yaml from here.
if [ "$MODE" = release ]; then
  RELDIR="$(mktemp -d "$WORK_ROOT/jm-release.XXXXXX")"
  cd "$RELDIR"
  if [ -f "$RELEASE" ]; then
    cp "$RELEASE" images.lock.json
    node "$ROOT/scripts/render-compose.ts" "$ROOT/deploy/compose.yaml.tmpl" images.lock.json >compose.yaml \
      || fail "render the template with $RELEASE"
  else
    for f in compose.yaml images.lock.json SHA256SUMS SHA256SUMS.sigstore.json; do
      curl -fsSLO "https://github.com/x-a-n-d-e-r-k/jumpmaster/releases/download/$RELEASE/$f" || fail "download $f for $RELEASE"
    done
    (sha256sum -c SHA256SUMS 2>/dev/null || shasum -a 256 -c SHA256SUMS) >/dev/null || fail "SHA256SUMS does not match"
    # The signature on SHA256SUMS, with the identity the stick verifies images against: cosign
    # from PATH, else from its image pinned by digest (mounting only the two files it reads).
    cosign_run() {
      if command -v cosign >/dev/null; then cosign "$@"; return; fi
      docker run --rm -w /w -v "$PWD/SHA256SUMS:/w/SHA256SUMS:ro" \
        -v "$PWD/SHA256SUMS.sigstore.json:/w/SHA256SUMS.sigstore.json:ro" \
        ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d "$@"
    }
    cosign_run verify-blob --bundle SHA256SUMS.sigstore.json \
      --certificate-identity-regexp '^https://github\.com/x-a-n-d-e-r-k/jumpmaster/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      --certificate-github-workflow-trigger push \
      --certificate-github-workflow-repository x-a-n-d-e-r-k/jumpmaster \
      SHA256SUMS >/dev/null 2>&1 || fail "the signature on SHA256SUMS does not verify"
    echo "release files: SHA256SUMS signed by the release workflow, files match: ok"
  fi
  grep -q 'JM_IMAGE_POLICY: signed' compose.yaml || fail "the compose file's stick is not signed"
  grep -qE 'JM_EGRESS_IMAGE: "?[^"]*@sha256:[0-9a-f]{64}' compose.yaml \
    || fail "the compose file's JM_EGRESS_IMAGE is not a digest"
  # The M4 compose an upgraded install had, rendered with the same images.
  node "$ROOT/scripts/render-compose.ts" "$ROOT/deploy/fixtures/m4-compose.yaml.tmpl" images.lock.json >m4-compose.yaml \
    || fail "render the M4 template"
  echo "release compose.yaml: signed stick, egress image by digest: ok"
  # A local lock's images carry no release signature: pin its egress proxy, as an operator pins an
  # image they built, so the stick's egress self-check can start it. In the environment, not in
  # .env: some cases start without one. A published release needs no pin.
  if [ -f "$RELEASE" ]; then
    JM_ALLOWED_IMAGES="$(grep -oE '[^" ]*/jumpmaster-egress@sha256:[0-9a-f]{64}' compose.yaml | head -1)"
    export JM_ALLOWED_IMAGES
  fi
else
  export JM_SOURCE="$ROOT"
fi

# A fresh, empty directory for a case, with compose.yaml in it: the current one, or M4's.
new_case() {
  cleanup_case
  WORK="$(mktemp -d "$WORK_ROOT/jm-smoke.XXXXXX")"
  cd "$WORK"
  use_compose "${2:-current}"
  SECRETS='SMOKE'
  echo "-- case $1 (in an empty directory)"
}
# compose.yaml is replaced in place, as an operator replaces it; the project name stays.
use_compose() {
  local project="jm-smoke-$$"
  if [ "$MODE" = dev ]; then
    if [ "$1" = m4 ]; then cp "$ROOT/deploy/fixtures/m4-compose.yaml.tmpl" compose.yaml
    else cp "$ROOT/deploy/compose.yaml.tmpl" compose.yaml; fi
    C=(docker compose -p "$project" --project-directory "$WORK" -f "$WORK/compose.yaml"
      -f "$ROOT/deploy/compose.build.yaml")
  else
    if [ "$1" = m4 ]; then cp "$RELDIR/m4-compose.yaml" compose.yaml
    else cp "$RELDIR/compose.yaml" compose.yaml; fi
    C=(docker compose -p "$project" --project-directory "$WORK" -f "$WORK/compose.yaml")
  fi
}
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL$1" 2>/dev/null || true; }
state_of() { "${C[@]}" ps -a --format '{{.State}} {{.ExitCode}}' "$1" 2>/dev/null | head -1; }
# The server answers over HTTP on the published port (or fail with its log tail as soon as it exits).
wait_server() {
  local code
  for _ in $(seq 180); do
    code="$(http_code /login)"
    case "$code" in 2* | 3* | 4*) return 0 ;; esac
    case "$(state_of jumpmaster)" in exited* | dead*) fail "the server exited: $(state_of jumpmaster)" ;; esac
    sleep 1
  done
  fail "the server did not answer on $URL within 180 s (last status ${code:-none})"
}
wait_stick() {
  for _ in $(seq 120); do
    "${C[@]}" logs stick 2>&1 | grep -q 'enrolled as' && return 0
    case "$(state_of stick)" in exited* | dead*) fail "the stick exited: $(state_of stick)" ;; esac
    sleep 1
  done
  fail "the stick did not enroll within 120 s"
}
# `up`, which runs bootstrap first and waits for the server's healthcheck before the stick.
up_ok() {
  local out
  out="$("${C[@]}" up -d "$@" 2>&1)" || fail "compose up: $(tail -5 <<<"$out")"
  wait_server
}
remember_machine_secrets() {
  local f
  for f in join_token operator_token vault_key; do
    [ -s "secrets/$f" ] && SECRETS="$SECRETS|$(cat "secrets/$f")"
  done
  return 0
}
check_layout() {
  [ "$(mode_of secrets)" = 700 ] || fail "secrets/ is mode $(mode_of secrets)"
  [ "$(mode_of data)" = 700 ] || fail "data/ is mode $(mode_of data)"
  [ -d config ] || fail "no config/ directory"
  [ "$(owner_of config)" = "$HOST_UID" ] || fail "config/ is not owned by $HOST_UID"
  for f in join_token operator_token vault_key; do
    [ "$(mode_of "secrets/$f")" = 600 ] || fail "secrets/$f is mode $(mode_of "secrets/$f")"
    [ "$(owner_of "secrets/$f")" = "$HOST_UID" ] || fail "secrets/$f is not owned by $HOST_UID"
  done
  [ -f data/jumpmaster.sqlite ] || fail "no database under ./data"
  [ "$(owner_of data/jumpmaster.sqlite)" = "$HOST_UID" ] || fail "the database is not owned by $HOST_UID"
  echo "bootstrap: secrets/ and data/ 0700, the three machine secrets 0600, owned by $HOST_UID: ok"
}
# The first-run path every case ends with.
setup_flow() {
  local lines out
  lines="$("${C[@]}" logs --no-log-prefix jumpmaster 2>&1 \
    | grep -cE '^JUMPMASTER SETUP CODE: [A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}  \(open http://127\.0\.0\.1:7420/setup; a restart prints a new code\)$' || true)"
  [ "$lines" = 1 ] || fail "the setup code line appears $lines times on the server's output"
  echo "setup code: once, on the server's own line: ok"
  [ "$(http_code /setup)" = 200 ] || fail "GET /setup answered $(http_code /setup)"
  echo "GET $URL/setup: 200: ok"
  wait_stick
  echo "stick: enrolled with secrets/join_token over the compose network: ok"
  out="$(printf '%s' "$PASSPHRASE" | "${C[@]}" exec -T jumpmaster jumpmaster ctl passphrase set 2>&1)" \
    || fail "ctl passphrase set: $out"
  grep -q '"operator":"claimed"' <<<"$out" || fail "ctl passphrase set answered: $out"
  [ "$(http_code /setup)" = 302 ] || fail "GET /setup after the passphrase answered $(http_code /setup)"
  echo "ctl passphrase set (stdin): setup mode ended: ok"
  no_secret "$("${C[@]}" logs 2>&1 | grep -v 'JUMPMASTER SETUP CODE')" "the logs"
  echo "no secret value in any log: ok"
}
put() { printf '%s\n' "$2" >"secrets/$1" && chmod 0600 "secrets/$1"; }
# The fix bootstrap printed, from its log: the text between `run  ` and `  and start again`, or
# after `.env to your user: `.
printed_fix() {
  "${C[@]}" logs --no-log-prefix bootstrap 2>&1 | sed -nE "$1" | tail -1
}
# A root container with only the capabilities the step needs (comma-separated; the services drop
# them all). DAC_OVERRIDE is what lets root into the host user's 0700 install directory.
as_root() {
  local caps=() cap
  for cap in ${1//,/ }; do caps+=(--cap-add "$cap"); done
  shift
  "${C[@]}" run --rm --no-deps --user 0:0 "${caps[@]}" --entrypoint "$1" bootstrap "${@:2}"
}

case_init() {
  new_case init
  printf 'JM_UID=%s\nJM_GID=%s\n' "$HOST_UID" "$HOST_GID" >.env
  mkdir -m 0700 secrets
  put claude_token sk-ant-oat01-SMOKEDUMMYSMOKEDUMMY
  put github_author_token github_pat_SMOKEAUTHORDUMMY
  put github_reviewer_token github_pat_SMOKEREVIEWERDUMMY
  "${C[@]}" config --quiet || fail "compose config"
  echo "compose config with .env: ok"
  # init: as root it refuses; as the host user it reaches GitHub, which refuses the dummy token.
  local out code
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
  remember_machine_secrets
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
  local env_before
  env_before="$(cat .env)"
  set +e
  out="$("${C[@]}" --profile init run --rm init --repo octo/demo --offline --preset node --identity starter 2>&1)"
  code=$?
  set -e
  remember_machine_secrets
  no_secret "$out" "init output"
  [ "$code" = 0 ] || fail "offline init exited $code: $out"
  [ -f config/jumpmaster.config.json ] || fail "offline init wrote no config"
  for f in join_token operator_token vault_key; do
    [ "$(mode_of "secrets/$f")" = 600 ] || fail "secrets/$f is mode $(mode_of "secrets/$f")"
    [ "$(owner_of "secrets/$f")" = "$HOST_UID" ] || fail "secrets/$f is not owned by $HOST_UID"
  done
  [ "$(cat .env)" = "$env_before" ] || fail "init changed .env: $(cat .env)"
  echo "init (offline, starter) in the container: config, the machine secrets 0600 by bootstrap, .env untouched: ok"
  # Observe mode, so nothing is dispatched against the dummy repository. The dev images are :dev
  # tags, which a signed install refuses.
  sed -i.bak 's/"crew": {/"mode": "observe", "crew": {/' config/jumpmaster.config.json
  [ "$MODE" = dev ] && sed -i.bak 's/"requireSignedImages": true/"requireSignedImages": false/' config/jumpmaster.config.json
  rm -f config/jumpmaster.config.json.bak
  up_ok
  check_layout
  echo "server: file mode, host uid, credentials read from secrets/ by name, no reviewer token: ok"
  wait_stick
  echo "stick: enrolled with the join token file over the compose network: ok"
  if [ "$MODE" = release ]; then
    "${C[@]}" logs stick 2>&1 | grep -qE 'image policy signed, capabilities .*image-verify-v1' \
      || fail "the stick does not run the signed policy with image-verify-v1"
    # Egress control: the stick proved a drop network keeps a drop off the host, with the
    # release's proxy image (verified, or pinned for a local lock).
    "${C[@]}" logs stick 2>&1 | grep -qE 'image policy signed, capabilities [^\n]*egress-v1' \
      || fail "the stick does not advertise egress-v1: $("${C[@]}" logs stick 2>&1 | grep -i 'egress-v1' | tail -2)"
    echo "stick: signed policy, image-verify-v1 and egress-v1: ok"
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
  # The doctor sees the host file's mode through the bind mount: 0644 fails, 0600 passes.
  doctor_after_restart() {
    "${C[@]}" restart jumpmaster >/dev/null 2>&1 || fail "restart jumpmaster"
    wait_server
    out="$("${C[@]}" exec -T jumpmaster jumpmaster ctl doctor 2>&1)" || true
  }
  chmod 644 secrets/claude_token
  doctor_after_restart
  grep -qE '^FAIL .*config\.secret-files' <<<"$out" || fail "a 0644 secret did not fail config.secret-files: $out"
  grep -q 'chmod 600 secrets/\*' <<<"$out" || fail "the config.secret-files fix is missing: $out"
  chmod 600 secrets/claude_token
  doctor_after_restart
  grep -qE '^PASS .*config\.secret-files' <<<"$out" || fail "config.secret-files did not pass again: $out"
  echo "config.secret-files on real files: 0644 fails with the chmod fix, 0600 passes: ok"
  no_secret "$("${C[@]}" logs 2>&1 | grep -v 'JUMPMASTER SETUP CODE')" "the logs"
  echo "no secret value in any log: ok"
  echo "case init: pass"
}

case_env_only() {
  new_case env-only
  printf 'JM_UID=%s\nJM_GID=%s\n' "$HOST_UID" "$HOST_GID" >.env
  up_ok
  remember_machine_secrets
  check_layout
  setup_flow
  echo "case env-only: pass"
}

case_empty() {
  new_case empty
  local out fix
  if out="$("${C[@]}" up -d 2>&1)"; then
    echo "up in an empty directory, with no .env (uid $HOST_UID): ok"
  else
    # Only a host whose user is not 1000 may stop here, and only with the .env line.
    [ "$HOST_UID" != 1000 ] || fail "up in an empty directory on a uid-1000 host: $(tail -5 <<<"$out")"
    fix="$(printed_fix 's/.*set JM_UID and JM_GID in \.env to your user: (.*)$/\1/p')"
    [ "$fix" = "printf 'JM_UID=%s\\nJM_GID=%s\\n' \"\$(id -u)\" \"\$(id -g)\" > .env" ] \
      || fail "bootstrap did not print the .env line: $("${C[@]}" logs --no-log-prefix bootstrap 2>&1 | tail -3)"
    echo "up in an empty directory (uid $HOST_UID, not 1000): bootstrap stopped with the .env line: ok"
    bash -c "$fix"
    out="$("${C[@]}" up -d 2>&1)" || fail "up after the .env line: $(tail -5 <<<"$out")"
    echo "the printed line run, up again: ok"
  fi
  wait_server
  remember_machine_secrets
  check_layout
  setup_flow
  echo "case empty: pass"
}

case_root_owned() {
  new_case root-owned
  printf 'JM_UID=%s\nJM_GID=%s\n' "$HOST_UID" "$HOST_GID" >.env
  # Root's files must look like root's: Docker Desktop's file sharing shows every file as owned
  # by whoever reads it, so a root-owned directory cannot exist there.
  local sudo=() out fix
  out="$(as_root DAC_OVERRIDE mkdir /install/.probe 2>&1)" || fail "a root container could not write the install directory: $out"
  if [ "$(owner_of .probe)" != 0 ]; then
    echo "case root-owned: skipped (this engine reports files root made as owned by uid $(owner_of .probe): no directory here can be root's; CI's Linux engine runs it)"
    return 0
  fi
  as_root DAC_OVERRIDE rmdir /install/.probe >/dev/null 2>&1
  out="$(as_root DAC_OVERRIDE mkdir -m 0755 /install/secrets /install/data /install/config 2>&1)" \
    || fail "make root's directories: $out"
  [ "$(owner_of secrets)$(owner_of data)$(owner_of config)" = 000 ] || fail "secrets/, data/ and config/ are not root's"
  if sudo -n true 2>/dev/null; then sudo=(sudo -n env "JM_SOURCE=${JM_SOURCE:-}" "JM_ALLOWED_IMAGES=${JM_ALLOWED_IMAGES:-}"); fi
  if out="$("${sudo[@]}" "${C[@]}" up -d 2>&1)"; then fail "up over root-owned directories did not stop"; fi
  fix="$(printed_fix 's/.*: run  (sudo chown -R [0-9]+:[0-9]+ secrets data( config)?)  and start again$/\1/p')"
  # The line names only the directories that exist, so it runs as printed.
  local dirs="secrets data"
  [ ! -e config ] || dirs="$dirs config"
  [ "$fix" = "sudo chown -R $HOST_UID:$HOST_GID $dirs" ] \
    || fail "bootstrap did not print the chown line: $("${C[@]}" logs --no-log-prefix bootstrap 2>&1 | tail -3)"
  echo "up${sudo[*]:+ with sudo} over root-owned secrets/, data/ and config/: stopped in bootstrap with the chown line: ok"
  [ "$(state_of jumpmaster)" != "running 0" ] || fail "the server started over a failed bootstrap"
  if [ ${#sudo[@]} -gt 0 ]; then
    bash -c "${fix/sudo /sudo -n }" || fail "run $fix"
    echo "ran: $fix"
  else
    local paths=()
    for d in $dirs; do paths+=("/install/$d"); done
    out="$(as_root CHOWN,DAC_OVERRIDE chown -R "$HOST_UID:$HOST_GID" "${paths[@]}" 2>&1)" \
      || fail "chown in a root container: $out"
    echo "no sudo without a password here: ran the same chown in a root container"
  fi
  up_ok
  remember_machine_secrets
  check_layout
  setup_flow
  echo "case root-owned: pass"
}

ZONE=demo
# An install as M4 left it: init's config and secrets under the M4 compose, the .env with init's
# block, a leftover reviewer token beside a starter zone, no vault key; run once, then stopped.
m4_install() {
  new_case "$1" m4
  printf 'JM_UID=%s\nJM_GID=%s\n' "$HOST_UID" "$HOST_GID" >.env
  mkdir -m 0700 secrets
  put claude_token sk-ant-oat01-SMOKEDUMMYSMOKEDUMMY
  put github_author_token github_pat_SMOKEAUTHORDUMMY
  put github_reviewer_token github_pat_SMOKEREVIEWERDUMMY
  local out
  out="$("${C[@]}" --profile init run --rm init --repo octo/demo --offline --preset node --identity starter 2>&1)" \
    || fail "init under the M4 compose: $out"
  # What the M4 init wrote beside it, and what it never wrote (T4 added the vault key).
  printf '%s\n' '# jumpmaster init: begin (rerun init to change these lines)' 'JM_REVIEWER_TOKEN_FILE=' \
    'JM_REVIEWER_TOKEN_SRC=/dev/null' '# jumpmaster init: end' >>.env
  rm -f secrets/vault_key
  sed -i.bak 's/"crew": {/"mode": "observe", "crew": {/' config/jumpmaster.config.json
  [ "$MODE" = dev ] && sed -i.bak 's/"requireSignedImages": true/"requireSignedImages": false/' config/jumpmaster.config.json
  rm -f config/jumpmaster.config.json.bak
  remember_machine_secrets
  # The M4 compose names its services: no bootstrap there.
  out="$("${C[@]}" up -d jumpmaster stick 2>&1)" || fail "up under the M4 compose: $(tail -5 <<<"$out")"
  wait_server
  out="$("${C[@]}" exec -T jumpmaster jumpmaster ctl pause "$ZONE" 2>&1)" || fail "ctl pause under M4: $out"
  echo "M4 install: init's files, its .env block, a leftover reviewer token, running, zone $ZONE paused: ok"
  "${C[@]}" down >/dev/null 2>&1 || fail "compose down"
  use_compose current
  echo "compose.yaml replaced with the current one (nothing else touched)"
}

# In the server container, on stdin: a JSON check, for hosts without node.
json_check() { "${C[@]}" exec -T jumpmaster node -e "$1"; }

case_upgrade() {
  m4_install "${1:-upgrade}"
  up_ok
  remember_machine_secrets
  check_layout
  setup_flow
  local out
  out="$("${C[@]}" exec -T jumpmaster jumpmaster ctl secrets list 2>&1)" || fail "ctl secrets list: $out"
  no_secret "$out" "ctl secrets list"
  json_check "
    const t = require('fs').readFileSync(0, 'utf8'); const j = JSON.parse(t.slice(t.indexOf('{')));
    const by = Object.fromEntries(j.credentials.map((c) => [c.name, c]));
    const files = { claudeToken: 'claude_token', githubAuthorToken: 'github_author_token', githubReviewerToken: 'github_reviewer_token' };
    for (const [n, f] of Object.entries(files)) {
      const c = by[n];
      if (!c || c.source !== 'file' || c.path !== '/secrets/' + f) { console.error(n, JSON.stringify(c)); process.exit(1); }
    }
    if (j.credentials.some((c) => c.source === 'env' || c.source === 'vault')) { console.error('not a file', t); process.exit(1); }
    if (j.vault !== 'on') { console.error('vault', j.vault); process.exit(1); }
    if (j.problems.length) { console.error('problems', JSON.stringify(j.problems)); process.exit(1); }
  " <<<"$out" || fail "the credentials after the upgrade: $out"
  echo "ctl secrets list: every credential from secrets/ by name (the leftover reviewer token too), the vault on, no credential problem, so no zone parked: ok"
  out="$(json_check "
    const D = require('better-sqlite3'); const db = new D('/data/jumpmaster.sqlite', { readonly: true });
    console.log(db.prepare('SELECT mode FROM zone_controls WHERE zone_id = ?').get('$ZONE')?.mode);
  " </dev/null 2>&1)" || fail "read the database: $out"
  [ "$out" = paused ] || fail "zone $ZONE is $out after the upgrade, not paused: the data was not kept"
  echo "data/: the M4 database kept (zone $ZONE still paused): ok"
  echo "case ${1:-upgrade}: pass"
}

case_roundtrip() {
  local out
  out="$("${C[@]}" exec -T jumpmaster jumpmaster ctl config adopt 2>&1)" || fail "ctl config adopt: $out"
  echo "ctl config adopt: db mode: ok"
  # The host export line, as the runbook gives it (-T: no pty, so no CRLF).
  "${C[@]}" exec -T jumpmaster jumpmaster ctl config export > config/jumpmaster.config.json.tmp && mv config/jumpmaster.config.json.tmp config/jumpmaster.config.json \
    || fail "the host export line"
  ! grep -q $'\r' config/jumpmaster.config.json || fail "the export has CRLF line ends"
  json_check "JSON.parse(require('fs').readFileSync(0, 'utf8'))" <config/jumpmaster.config.json \
    || fail "the export is not JSON"
  no_secret "$(cat config/jumpmaster.config.json)" "the export"
  out="$("${C[@]}" exec -T jumpmaster jumpmaster ctl config mode file 2>&1)" || fail "ctl config mode file: $out"
  echo "host export line, then ctl config mode file: back in file mode: ok"
  "${C[@]}" restart jumpmaster >/dev/null 2>&1 || fail "restart jumpmaster"
  wait_server
  out="$("${C[@]}" exec -T jumpmaster jumpmaster ctl config show --json 2>&1)" || fail "ctl config show after a restart: $out"
  grep -q '"mode":"file"' <<<"${out//[[:space:]]/}" || fail "not in file mode after a restart: $out"
  echo "restart: the exported file serves file mode: ok"
  echo "case roundtrip: pass"
}

case "$CASE" in
  init) case_init ;;
  env-only) case_env_only ;;
  empty) case_empty ;;
  root-owned) case_root_owned ;;
  upgrade) case_upgrade ;;
  roundtrip)
    case_upgrade roundtrip-setup
    case_roundtrip
    ;;
  all)
    case_init
    case_env_only
    case_empty
    case_root_owned
    case_upgrade
    case_roundtrip
    ;;
esac
cleanup_case
echo "compose smoke ($MODE, $CASE): pass"
