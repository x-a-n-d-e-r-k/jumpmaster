#!/usr/bin/env bash
# Lazy-fetch e2e, against the real engine, offline. The push container stages the agent's branch with
# a hardened upload-pack (`env GIT_NO_LAZY_FETCH=1 ...`), because a working copy the agent controls can
# be a partial clone whose promisor remote names any address, and a plain upload-pack would reach out
# to it. Inside the trooper image, as the agent uid with --network none, this builds such a working
# copy (promisor remote = a recording wrapper) and checks:
#   - control: with lazy fetching left on, reading the missing blob does make the promisor call (so
#     the marker proves something);
#   - hardened: with the exact HARDENED_UPLOAD_PACK command, no promisor call is made and the
#     missing blob is refused with "lazy fetching disabled".
# Builds jumpmaster-trooper:dev first (cached when current). Exits non-zero on failure.
set -euo pipefail
cd "$(dirname "$0")/../../.."
docker build -q --build-arg SOURCE_URL="${SOURCE_URL:-}" -t jumpmaster-trooper:dev -f images/trooper/Dockerfile . >/dev/null
echo "lazy-fetch e2e: Docker Engine $(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
# Keep in step with HARDENED_UPLOAD_PACK in apps/trooper/src/git.ts (a unit test pins both).
HARDENED='env GIT_NO_LAZY_FETCH=1 git -c core.fsmonitor=false -c core.hooksPath=/dev/null upload-pack'

# shellcheck disable=SC2016
INNER='
set -eu
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
T=$(mktemp -d)
git init -q --bare "$T/origin.git"
git -C "$T/origin.git" config uploadpack.allowFilter true
git -C "$T/origin.git" config uploadpack.allowAnySHA1InWant true
git init -q "$T/seed"
echo secret-blob-content > "$T/seed/f.txt"
git -C "$T/seed" add f.txt && git -C "$T/seed" commit -q -m seed
git -C "$T/seed" push -q "$T/origin.git" HEAD:refs/heads/work
# The promisor remote records every call before serving it.
cat > "$T/rec.sh" <<REC
#!/bin/sh
echo called >> "$T/marker"
exec git-upload-pack "\$@"
REC
chmod +x "$T/rec.sh"
R=/home/agent/repo
git clone -q --no-checkout --filter=blob:none "file://$T/origin.git" "$R"
git -C "$R" config remote.origin.uploadpack "$T/rec.sh"
rm -f "$T/marker"
BLOB=$(git -C "$R" rev-parse origin/work:f.txt 2>/dev/null || git -C "$T/origin.git" rev-parse work:f.txt)
stage() { # command -> prints exit code; fresh bare destination
  rm -rf "$T/dest.git"; git init -q --bare "$T/dest.git"
  set +e
  git -C "$T/dest.git" fetch -q --upload-pack="$1" "$R" "refs/remotes/origin/work:refs/heads/work" 2>"$T/err"
  echo $? > "$T/rc"; set -e
}
# Control: with lazy fetching left on, reading the missing blob does call the promisor remote. (Recent
# git already refuses lazy fetches inside upload-pack itself; the env var is defence in depth, so the
# control exercises the raw lazy fetch rather than the unhardened upload-pack.)
git -C "$R" cat-file -p "$BLOB" >/dev/null 2>&1 || true
[ -f "$T/marker" ] || { echo "FAIL: control: a lazy fetch made no promisor call; the check proves nothing" >&2; exit 1; }
echo "control: a lazy fetch reaches the promisor remote: ok"
# Reset the working copy to a partial state again (the control fetched the blob).
rm -rf "$R"; mkdir "$R"
git clone -q --no-checkout --filter=blob:none "file://$T/origin.git" "$R"
git -C "$R" config remote.origin.uploadpack "$T/rec.sh"
rm -f "$T/marker"
stage "'"$HARDENED"'"
if [ -f "$T/marker" ]; then echo "FAIL: hardened stage reached the promisor remote" >&2; exit 1; fi
echo "hardened: no promisor call: ok (stage exit $(cat "$T/rc"))"
# The missing blob is refused outright, not fetched.
rm -f "$T/marker"
if out=$(GIT_NO_LAZY_FETCH=1 git -C "$R" cat-file -p "$BLOB" 2>&1); then echo "FAIL: blob was readable with lazy fetch disabled" >&2; exit 1; fi
case "$out" in *"lazy fetching disabled"*) echo "hardened: cat-file refused: lazy fetching disabled: ok" ;; *) echo "FAIL: unexpected refusal: $out" >&2; exit 1 ;; esac
[ ! -f "$T/marker" ] || { echo "FAIL: cat-file reached the promisor remote" >&2; exit 1; }
echo PASS
'
docker run --rm --network none --user 10001:10001 -e HOME=/home/agent --entrypoint sh jumpmaster-trooper:dev -c "$INNER"
