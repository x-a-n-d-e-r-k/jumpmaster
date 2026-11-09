#!/usr/bin/env bash
# Joins each image's per-arch builds into one multi-arch index (release-build.yml). Reads
# digests/$GROUP-amd64.json and digests/$GROUP-arm64.json (image name -> per-arch digest, as
# build-push-action output it). For a release (RELEASE=true) it creates, for every image,
#   $REGISTRY/<name>:v$VERSION  from  $REGISTRY/<name>@<amd64 digest> and @<arm64 digest>
# (sources by digest; buildx needs a tag to push an index to), reads the new index's digest,
# checks the index holds exactly one linux/amd64 and one linux/arm64 image (plus their
# attestations), and writes `<name>=<index digest>` to $GITHUB_OUTPUT. The index digest is what
# the release signs and locks, and what a stick pulls and verifies.
# A dry run has no shared registry (each arch pushed to its own job-local one), so it creates no
# index and passes the amd64 digests through, saying so.
set -euo pipefail
: "${GROUP:?}" "${REGISTRY:?}" "${VERSION:?}" "${GITHUB_OUTPUT:?}"
DIGEST_RE='^sha256:[0-9a-f]{64}$'
amd="digests/${GROUP}-amd64.json"
arm="digests/${GROUP}-arm64.json"
for f in "$amd" "$arm"; do
  [ -f "$f" ] || { echo "::error::missing $f"; exit 1; }
done
names="$(jq -r 'keys[]' "$amd")"
[ "$names" = "$(jq -r 'keys[]' "$arm")" ] || { echo "::error::$amd and $arm name different images"; exit 1; }
for name in $names; do
  [[ "$name" =~ ^jumpmaster-[a-z-]+$ ]] || { echo "::error::unexpected image name $name"; exit 1; }
  a="$(jq -r --arg n "$name" '.[$n]' "$amd")"
  b="$(jq -r --arg n "$name" '.[$n]' "$arm")"
  [[ "$a" =~ $DIGEST_RE && "$b" =~ $DIGEST_RE ]] || { echo "::error::$name: a per-arch digest is not sha256"; exit 1; }
  if [ "${RELEASE:-false}" != true ]; then
    echo "::notice::dry run: no index for $name (the arches were pushed to separate job-local registries)"
    echo "${name}=${a}" >> "$GITHUB_OUTPUT"
    continue
  fi
  docker buildx imagetools create -t "${REGISTRY}/${name}:v${VERSION}" \
    "${REGISTRY}/${name}@${a}" "${REGISTRY}/${name}@${b}"
  index="$(docker buildx imagetools inspect "${REGISTRY}/${name}:v${VERSION}" --format '{{json .Manifest}}' | jq -r .digest)"
  [[ "$index" =~ $DIGEST_RE ]] || { echo "::error::$name: no index digest"; exit 1; }
  # The index holds exactly the two images just built: its linux/amd64 and linux/arm64 entries
  # are the image manifests inside the amd64 and arm64 builds.
  images='[.manifests[] | select(.platform.os != "unknown") | "\(.platform.os)/\(.platform.architecture) \(.digest)"] | sort | join(",")'
  got="$(docker buildx imagetools inspect "${REGISTRY}/${name}@${index}" --raw | jq -r "$images")"
  want_a="$(docker buildx imagetools inspect "${REGISTRY}/${name}@${a}" --raw | jq -r "$images")"
  want_b="$(docker buildx imagetools inspect "${REGISTRY}/${name}@${b}" --raw | jq -r "$images")"
  [[ "$want_a" == linux/amd64\ * && "$want_b" == linux/arm64\ * ]] || { echo "::error::$name: the per-arch builds are '$want_a' and '$want_b'"; exit 1; }
  [ "$got" = "${want_a},${want_b}" ] || { echo "::error::$name index holds '$got', not '${want_a},${want_b}'"; exit 1; }
  echo "${name}=${index}" >> "$GITHUB_OUTPUT"
done
