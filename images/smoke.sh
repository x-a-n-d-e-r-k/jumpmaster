#!/usr/bin/env bash
# Runtime smoke test of the server and stick images, without any real token. Expects
# jumpmaster-server:dev and jumpmaster-stick:dev to be built (images.yml builds them). Checks:
#   - the server image has no Docker client and runs as uid 10000 by default;
#   - the server starts with a read-only root, a tmpfs /tmp, file secrets (*_FILE) and the host
#     uid, writes its database under /data, and answers `jumpmaster ctl` through `docker exec`;
#   - on Linux, the default uid 10000 cannot read a host-owned 0600 secret and says so by name;
#   - the stick, read-only with only /state writable, enrolls from a join-token file and keeps
#     stick.json at mode 0600 under /state; it starts under its signed image policy (its cosign is
#     the pinned version) and advertises image-verify-v1.
# Prints one line per check; exits non-zero on the first failure.
set -euo pipefail
SERVER_IMAGE="${SMOKE_SERVER_IMAGE:-jumpmaster-server:dev}"
STICK_IMAGE="${SMOKE_STICK_IMAGE:-jumpmaster-stick:dev}"
ID="$$"
NET="jm-smoke-$ID"
SERVER="jm-smoke-server-$ID"
STICK="jm-smoke-stick-$ID"
WORK="$(mktemp -d)"
cleanup() {
  docker rm -f "$SERVER" "$STICK" "$SERVER-default" >/dev/null 2>&1 || true
  docker volume rm "jm-smoke-state-$ID" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*" >&2
  docker logs "$SERVER" 2>&1 | tail -20 >&2 || true
  docker logs "$STICK" 2>&1 | tail -20 >&2 || true
  exit 1
}
# Waits up to $3 seconds for a container's logs to contain a fixed string.
wait_log() {
  local name="$1" want="$2" limit="$3" i
  for ((i = 0; i < limit; i++)); do
    if docker logs "$name" 2>&1 | grep -qF -- "$want"; then return 0; fi
    sleep 1
  done
  return 1
}

# Static facts about the server image.
out="$(docker run --rm --entrypoint sh "$SERVER_IMAGE" -c \
  'id -u; command -v docker || echo no-docker; test -e /app/node_modules/dockerode && echo dockerode || echo no-dockerode')"
[ "$out" = "$(printf '10000\nno-docker\nno-dockerode')" ] || fail "server image facts: $out"
echo "server image: uid 10000, no docker client, no dockerode: ok"

# Secrets, owned by the host user at 0600, and a config.
mkdir -p "$WORK/secrets" "$WORK/config" "$WORK/data"
put() { printf '%s\n' "$2" >"$WORK/secrets/$1" && chmod 0600 "$WORK/secrets/$1"; }
put claude sk-ant-oat01-SMOKEDUMMYSMOKEDUMMY
put author github_pat_SMOKEAUTHORDUMMY
put reviewer github_pat_SMOKEREVIEWERDUMMY
put join smoke-join-token-0123456789
put operator smoke-operator-token-0123456789abcdef
cat >"$WORK/config/jumpmaster.config.json" <<'JSON'
{
  "dataDir": "/data",
  "listen": { "host": "0.0.0.0", "port": 7420, "allowedHosts": ["127.0.0.1:7420", "jumpmaster:7420"] },
  "pollSeconds": 3600,
  "dropZones": [
    { "id": "main", "repo": "octo/demo", "mode": "observe", "image": "jumpmaster-trooper:dev",
      "gates": [{ "name": "test", "run": "true" }] }
  ]
}
JSON
secret_env=(
  -e JM_CLAUDE_TOKEN_FILE=/run/secrets/claude
  -e JM_GITHUB_AUTHOR_TOKEN_FILE=/run/secrets/author
  -e JM_GITHUB_REVIEWER_TOKEN_FILE=/run/secrets/reviewer
  -e JM_JOIN_TOKEN_FILE=/run/secrets/join
  -e JM_OPERATOR_TOKEN_FILE=/run/secrets/operator
)
hardened=(--read-only --tmpfs /tmp --security-opt no-new-privileges --cap-drop ALL)
docker network create "$NET" >/dev/null

if [ "$(uname -s)" = Linux ] && [ "$(id -u)" != 10000 ] && [ "$(id -u)" != 0 ]; then
  # The image's default uid cannot read the host user's 0600 secrets; startup names the variable.
  docker run -d --name "$SERVER-default" "${hardened[@]}" \
    -v "$WORK/config:/config:ro" -v "$WORK/secrets:/run/secrets:ro" "${secret_env[@]}" \
    "$SERVER_IMAGE" >/dev/null
  wait_log "$SERVER-default" "is not readable by uid 10000" 30 \
    || fail "an unreadable secret was not reported by name"
  if docker logs "$SERVER-default" 2>&1 | grep -q SMOKE; then fail "a secret value was logged"; fi
  echo "unreadable secret reported by variable, path and uid: ok"
else
  echo "unreadable secret check: skipped (needs a non-root Linux host user other than 10000)"
fi

docker run -d --name "$SERVER" --network "$NET" --network-alias jumpmaster "${hardened[@]}" \
  --user "$(id -u):$(id -g)" \
  -v "$WORK/config:/config:ro" -v "$WORK/secrets:/run/secrets:ro" -v "$WORK/data:/data" \
  "${secret_env[@]}" "$SERVER_IMAGE" >/dev/null
wait_log "$SERVER" "listening on 0.0.0.0:7420" 60 || fail "server did not start"
[ -f "$WORK/data/jumpmaster.sqlite" ] || fail "no database under /data"
echo "server: read-only root, file secrets, host uid, database under /data: ok"

out="$(docker exec "$SERVER" jumpmaster ctl briefings)" || fail "ctl briefings: $out"
case "$out" in 200*) ;; *) fail "ctl briefings answered: $out" ;; esac
out="$(docker exec -e JM_OPERATOR_TOKEN_FILE=/run/secrets/claude "$SERVER" jumpmaster ctl briefings || true)"
case "$out" in 401*) ;; *) fail "ctl with the wrong token answered: $out" ;; esac
echo "jumpmaster ctl through docker exec, operator token from a file: ok"

docker volume create "jm-smoke-state-$ID" >/dev/null
docker run -d --name "$STICK" --network "$NET" --read-only --tmpfs /tmp \
  -v /var/run/docker.sock:/var/run/docker.sock -v "jm-smoke-state-$ID:/state" \
  -v "$WORK/secrets/join:/run/secrets/join:ro" \
  -e JM_SERVER_URL=http://jumpmaster:7420 -e JM_JOIN_TOKEN_FILE=/run/secrets/join \
  -e JM_STICK_NAME=smoke "$STICK_IMAGE" >/dev/null
wait_log "$STICK" "enrolled as" 60 || fail "stick did not enroll"
# The stick image runs the signed policy with its shipped cosign, so it advertises image-verify-v1.
docker logs "$STICK" 2>&1 | grep -qE "image policy signed, capabilities (egress-v1, )?image-verify-v1" \
  || fail "stick did not start under the signed policy with image-verify-v1"
mode="$(docker exec "$STICK" stat -c '%a %U' /state/stick.json)"
[ "$mode" = "600 root" ] || fail "stick.json is $mode"
if docker exec "$STICK" sh -c 'touch /app/x' 2>/dev/null; then fail "stick root is writable"; fi
for name in "$SERVER" "$STICK"; do
  if docker logs "$name" 2>&1 | grep -q 'SMOKE\|smoke-join-token\|smoke-operator-token'; then
    fail "a secret value appears in the $name logs"
  fi
done
echo "stick: read-only root, enrolled from a join-token file, /state/stick.json 0600, signed policy: ok"
echo "smoke: pass"
