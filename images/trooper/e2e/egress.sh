#!/usr/bin/env bash
# Egress e2e, against the real engine and without any token. Builds the trooper (with the fake
# Claude CLI and the egress probe), the egress proxy (locally: pulling by digest arrives with image
# verification), the stick and a sidecar image, then runs the stick's own runDrop inside the stick
# image on three review drops of a public repository:
#   - enforce: from the gate user, an allowed host works through the proxy; an unlisted host, a raw
#     IP, the metadata address, IPv6, the drop gateway (a host listener) and DNS (A over getent, TXT
#     to the embedded resolver, UDP to a public resolver) all fail. From the service: no external
#     DNS, no route out. From jm-egress-out: the proxy accepts nothing.
#   - monitor: unlisted public hosts go through and are reported; private answers are still refused.
#   - fail closed: a proxy image that isn't there fails the drop before any trooper exists.
#   - an image whose trooper predates egress (no egress label) fails the drop, enforce or monitor,
#     before any network, proxy or trooper exists.
# Controls first prove each refusal means something: from the default bridge the host listener,
# a raw IP and external DNS all work. Exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/../../.."
REPO="${E2E_REPO:-x-a-n-d-e-r-k/jumpmaster}"
BRANCH="${E2E_BRANCH:-main}"
SOURCE_URL="${SOURCE_URL:-}"
# Pinned by digest (alpine 3.20, multi-arch index): the host listener and the probe containers.
ALPINE="alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
HOST_PORT=39999
LISTENER="jm-e2e-hostlisten-$$"
# The architecture these images were built for and ran on (release images are amd64 and arm64).
echo "egress e2e: Docker Engine $(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
SHA="$(git ls-remote "https://github.com/${REPO}.git" "refs/heads/${BRANCH}" | cut -f1)"
[ -n "$SHA" ] || { echo "cannot resolve ${REPO}@${BRANCH}" >&2; exit 1; }

cleanup() {
  docker rm -f "$LISTENER" >/dev/null 2>&1 || true
  for id in $(docker ps -aq --filter label=jumpmaster.stick=e2e-stick); do docker rm -f "$id" >/dev/null 2>&1 || true; done
  for n in $(docker network ls -q --filter label=jumpmaster.stick=e2e-stick); do docker network rm "$n" >/dev/null 2>&1 || true; done
  for n in $(docker network ls -q --filter label=jumpmaster.egress-probe=1); do docker network rm "$n" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

docker build -q --build-arg SOURCE_URL="$SOURCE_URL" -t jumpmaster-trooper:dev -f images/trooper/Dockerfile . >/dev/null
docker build -q -t jumpmaster-trooper:e2e images/trooper/e2e >/dev/null
# The same trooper as if built before egress: its egress label emptied (a label can't be removed).
printf 'FROM jumpmaster-trooper:e2e\nLABEL org.jumpmaster.trooper.egress=""\n' |
  docker build -q -t jumpmaster-trooper:e2e-pre-egress - >/dev/null
docker build -q --build-arg SOURCE_URL="$SOURCE_URL" -t jumpmaster-egress:dev -f images/egress/Dockerfile . >/dev/null
docker build -q --build-arg SOURCE_URL="$SOURCE_URL" -t jumpmaster-stick:dev -f images/stick/Dockerfile . >/dev/null
docker build -q --build-arg SOURCE_URL="$SOURCE_URL" -t jumpmaster-e2e-service:dev -f images/trooper/e2e/service.Dockerfile images/trooper/e2e >/dev/null

# Something on the host listening on every address, as a stranger's home server might.
docker run -d --name "$LISTENER" --network host "$ALPINE" \
  sh -c "while true; do nc -l -p $HOST_PORT -e echo hi; done" >/dev/null
sleep 1

# Controls: without egress, each path the drop must not have works.
control() { # label, script
  if docker run --rm "$ALPINE" sh -c "$2" >/dev/null 2>&1; then echo "control: $1: ok"; else
    echo "FAIL: control: $1 does not work even without egress, so its refusal proves nothing" >&2
    exit 1
  fi
}
control 'the host listener answers through a bridge gateway' \
  "nc -z -w 3 \$(ip route | awk '/default/ {print \$3}') $HOST_PORT"
control 'a raw public IP is reachable' 'nc -z -w 3 1.1.1.1 443'
control 'an external name resolves' 'getent hosts example.com'

docker run --rm --read-only --tmpfs /tmp \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --mount "type=bind,src=$PWD/images/trooper/e2e/egress-drop.mjs,dst=/e2e/egress-drop.mjs,readonly" \
  -e E2E_REPO="$REPO" -e E2E_BRANCH="$BRANCH" -e E2E_SHA="$SHA" -e E2E_ALPINE="$ALPINE" \
  -e E2E_HOST_PORT="$HOST_PORT" -e HOSTNAME=e2e-stick \
  --entrypoint node jumpmaster-stick:dev /e2e/egress-drop.mjs
