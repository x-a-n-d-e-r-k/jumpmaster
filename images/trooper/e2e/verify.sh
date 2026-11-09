#!/usr/bin/env bash
# Image verification e2e, against the real engine and Sigstore, without any token. Builds the
# trooper (with the fake Claude CLI) and the stick (trusting E2E_REPO's release workflow), pushes
# an unsigned copy of the trooper to a local registry and removes it locally, then runs the
# stick's own startup check and runDrop inside the stick image, under its signed policy, its
# shipped cosign and a read-only root (/state writable):
#   - a non-digest pin refuses startup; the real startup passes and advertises image-verify-v1;
#   - a tag is refused before any pull or container;
#   - the unsigned image, by digest, is refused by cosign and never downloaded; nothing is created;
#   - an image signed keyless by another identity (Sigstore's cosign image) is refused;
#   - the same unsigned image, pinned by digest in JM_ALLOWED_IMAGES, runs a review drop;
#   - under egress, an unpinned unsigned proxy image is refused before any download, network or
#     container, and once pinned the drop runs through it.
# Exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/../../.."
REPO="${E2E_REPO:-x-a-n-d-e-r-k/jumpmaster}"
BRANCH="${E2E_BRANCH:-main}"
SOURCE_URL="${SOURCE_URL:-}"
# Pinned by digest: the local registry (distribution 3.1.1) and an image Sigstore signs keyless
# with its own identity (cosign v3.1.4), which this repository's identity must not accept.
REGISTRY_IMAGE="registry:3.1.1@sha256:325b4b29b041e82803abeb703e201655e4e23ab83264ec1a7c9ddb0a5b14a6e0"
OTHER_SIGNED="ghcr.io/sigstore/cosign/cosign@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d"
REG="jm-e2e-registry-$$"
# The architecture these images were built for and ran on (release images are amd64 and arm64).
echo "verify e2e: Docker Engine $(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
SHA="$(git ls-remote "https://github.com/${REPO}.git" "refs/heads/${BRANCH}" | cut -f1)"
[ -n "$SHA" ] || { echo "cannot resolve ${REPO}@${BRANCH}" >&2; exit 1; }

UNSIGNED=""
cleanup() {
  docker rm -f "$REG" >/dev/null 2>&1 || true
  for id in $(docker ps -aq --filter label=jumpmaster.stick=e2e-verify); do docker rm -f "$id" >/dev/null 2>&1 || true; done
  [ -z "$UNSIGNED" ] || docker image rm "$UNSIGNED" >/dev/null 2>&1 || true
  [ -z "${EGRESS_UNSIGNED:-}" ] || docker image rm "$EGRESS_UNSIGNED" >/dev/null 2>&1 || true
  for n in $(docker network ls -q --filter label=jumpmaster.stick=e2e-verify); do docker network rm "$n" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

docker build -q --build-arg SOURCE_URL="$SOURCE_URL" -t jumpmaster-trooper:dev -f images/trooper/Dockerfile . >/dev/null
docker build -q -t jumpmaster-trooper:e2e images/trooper/e2e >/dev/null
docker build -q --build-arg SOURCE_URL="$SOURCE_URL" --build-arg RELEASE_REPOSITORY="$REPO" -t jumpmaster-stick:dev -f images/stick/Dockerfile . >/dev/null
docker build -q --build-arg SOURCE_URL="$SOURCE_URL" -t jumpmaster-egress:dev -f images/egress/Dockerfile . >/dev/null

# A registry on the host's loopback: the engine pulls from it, and the stick (on the host network)
# asks it for signatures.
# A fixed port, not an ephemeral one: Docker Desktop maps an ephemeral host port to a different
# port inside its VM, where the engine pulls from.
PORT=""
for p in $(seq 5100 5199); do
  if docker run -d --name "$REG" -p "127.0.0.1:${p}:5000" "$REGISTRY_IMAGE" >/dev/null 2>&1; then PORT="$p"; break; fi
  docker rm -f "$REG" >/dev/null 2>&1 || true
done
[ -n "$PORT" ] || { echo "no free port for the local registry in 5100-5199" >&2; exit 1; }
for _ in $(seq 1 30); do
  if docker run --rm --network host "$REGISTRY_IMAGE" sh -c "wget -q -O /dev/null http://127.0.0.1:${PORT}/v2/" >/dev/null 2>&1; then break; fi
  sleep 1
done
LOCAL="127.0.0.1:${PORT}/jumpmaster-trooper-e2e"
docker tag jumpmaster-trooper:e2e "${LOCAL}:unsigned"
docker push -q "${LOCAL}:unsigned" >/dev/null
UNSIGNED="$(docker image inspect "${LOCAL}:unsigned" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep "^${LOCAL}@sha256:" | head -n1)"
[ -n "$UNSIGNED" ] || { echo "no digest for ${LOCAL}:unsigned" >&2; exit 1; }
# The egress proxy too: under signed it is verified, then pulled by digest, like any image.
LOCAL_EGRESS="127.0.0.1:${PORT}/jumpmaster-egress-e2e"
docker tag jumpmaster-egress:dev "${LOCAL_EGRESS}:unsigned"
docker push -q "${LOCAL_EGRESS}:unsigned" >/dev/null
EGRESS_UNSIGNED="$(docker image inspect "${LOCAL_EGRESS}:unsigned" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep "^${LOCAL_EGRESS}@sha256:" | head -n1)"
[ -n "$EGRESS_UNSIGNED" ] || { echo "no digest for ${LOCAL_EGRESS}:unsigned" >&2; exit 1; }
# Gone locally, so the stick has to pull them by digest.
docker image rm "${LOCAL}:unsigned" "$UNSIGNED" "${LOCAL_EGRESS}:unsigned" "$EGRESS_UNSIGNED" >/dev/null 2>&1 || true
docker image rm "$OTHER_SIGNED" >/dev/null 2>&1 || true

docker run --rm --network host --read-only --tmpfs /tmp --tmpfs /state:mode=0700 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --mount "type=bind,src=$PWD/images/trooper/e2e/verify-drop.mjs,dst=/e2e/verify-drop.mjs,readonly" \
  -e E2E_REPO="$REPO" -e E2E_BRANCH="$BRANCH" -e E2E_SHA="$SHA" \
  -e E2E_UNSIGNED="$UNSIGNED" -e E2E_EGRESS_UNSIGNED="$EGRESS_UNSIGNED" -e E2E_OTHER_SIGNED="$OTHER_SIGNED" \
  --entrypoint node jumpmaster-stick:dev /e2e/verify-drop.mjs
