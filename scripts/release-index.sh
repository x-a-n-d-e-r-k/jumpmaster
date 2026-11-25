#!/usr/bin/env bash
# Joins each image's per-arch builds into one multi-arch index (release-build.yml). Reads
# digests/$GROUP-amd64.json and digests/$GROUP-arm64.json (image name -> per-arch digest, as
# build-push-action output it; each is itself a small index of the image and its attestation).
# For a release (RELEASE=true), for every image:
#   1. asks buildx for the index it would create from <name>@<amd64> and <name>@<arm64> (by
#      digest) without pushing, and takes the index digest from those exact bytes;
#   2. checks that index lists exactly every manifest the two builds list, attestations
#      included, and that each build is the arch it claims;
#   3. pushes it (buildx needs a tag, $REGISTRY/<name>:v$VERSION, which nothing trusts);
#   4. reads it back by that digest, never by the tag, and checks the bytes hash to it (a
#      registry may not serve a just-pushed manifest for a moment: "not found" is read again,
#      up to 6 reads 5 s apart; any other failure, and any mismatch, fails at once);
#   5. writes `<name>=<index digest>` to $GITHUB_OUTPUT: what the release signs, locks and what
#      a stick pulls and verifies.
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

# Every manifest of an index, one per line: media type, platform and digest. Entries without a
# platform show as -/- and still count.
entries='.manifests[] | "\(.mediaType) \(.platform.os // "-")/\(.platform.architecture // "-") \(.digest)"'
sha() { printf 'sha256:%s' "$(sha256sum | cut -d' ' -f1)"; }

# read_index <ref>: the raw manifest at <ref>, read up to 6 times 5 s apart while the registry
# answers "not found" (it can lag a moment behind a push). Any other error fails at once; the
# last error is printed when the tries run out. Only for the read-back after the push.
read_index() {
  local ref="$1" errf out err try
  errf="$(mktemp)"
  for try in 1 2 3 4 5 6; do
    if out="$(docker buildx imagetools inspect "$ref" --raw 2>"$errf")"; then
      rm -f "$errf"
      printf '%s' "$out"
      return 0
    fi
    err="$(cat "$errf")"
    if ! grep -qi 'not found' <<<"$err"; then
      rm -f "$errf"
      echo "$err" >&2
      return 1
    fi
    [ "$try" = 6 ] || sleep 5
  done
  rm -f "$errf"
  echo "$err" >&2
  echo "::error::$ref is still not found after 6 reads" >&2
  return 1
}

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
  src_a="${REGISTRY}/${name}@${a}"
  src_b="${REGISTRY}/${name}@${b}"
  tag="${REGISTRY}/${name}:v${VERSION}"

  # What each build is: exactly one linux image of its own arch, plus its attestations.
  list_a="$(docker buildx imagetools inspect "$src_a" --raw | jq -r "$entries" | sort)"
  list_b="$(docker buildx imagetools inspect "$src_b" --raw | jq -r "$entries" | sort)"
  if ! { [ "$(grep -c ' linux/' <<<"$list_a")" = 1 ] && grep -q ' linux/amd64 ' <<<"$list_a"; }; then
    echo "::error::$name: the amd64 build lists: $list_a"
    exit 1
  fi
  if ! { [ "$(grep -c ' linux/' <<<"$list_b")" = 1 ] && grep -q ' linux/arm64 ' <<<"$list_b"; }; then
    echo "::error::$name: the arm64 build lists: $list_b"
    exit 1
  fi
  want="$(printf '%s\n%s\n' "$list_a" "$list_b" | sort)"

  # The index, before it is pushed: its digest is the hash of these bytes ($(...) drops the
  # newline buildx prints after them).
  planned="$(docker buildx imagetools create --dry-run -t "$tag" "$src_a" "$src_b")"
  index="$(printf '%s' "$planned" | sha)"
  got="$(printf '%s' "$planned" | jq -r "$entries" | sort)"
  [ "$got" = "$want" ] || { echo "::error::$name: the index would list"$'\n'"$got"$'\n'"not"$'\n'"$want"; exit 1; }

  docker buildx imagetools create -t "$tag" "$src_a" "$src_b"

  # Read back by digest only: the registry must serve exactly those bytes there.
  served="$(read_index "${REGISTRY}/${name}@${index}")"
  [ "$(printf '%s' "$served" | sha)" = "$index" ] \
    || { echo "::error::$name: the registry does not serve the planned index at $index"; exit 1; }
  echo "${name}=${index}" >> "$GITHUB_OUTPUT"
done
