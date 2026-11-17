#!/usr/bin/env bash
# Refuses a release whose commit has no successful Images run on main. The release builds and
# signs, but runs none of the image e2e tests (egress, image verification, the push container,
# the compose install, the presets, arm64): images.yml runs them on every push to main, and this
# makes the tagged commit's run a precondition. Fails closed: a failed read or an answer that
# isn't a count refuses the release. Usage: release-images-green.sh <commit>
set -euo pipefail
commit="${1:?usage: release-images-green.sh <commit>}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
query="repos/$repo/actions/workflows/images.yml/runs?head_sha=$commit&event=push&branch=main&status=success&per_page=1"
if ! count="$(gh api "$query" --jq '.total_count')"; then
  echo "::error::could not read the Images runs for $commit: nothing is built or signed"
  exit 1
fi
if ! [[ "$count" =~ ^[0-9]+$ ]] || [ "$count" -eq 0 ]; then
  echo "::error::$commit has no successful Images run on main, so its e2e tests haven't passed: nothing is built or signed. Wait for that run (or fix main), then re-run this workflow."
  exit 1
fi
echo "Images passed on main for $commit"
