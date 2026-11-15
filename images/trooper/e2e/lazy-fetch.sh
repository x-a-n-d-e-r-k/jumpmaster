#!/usr/bin/env bash
# Lazy-fetch e2e, against the real engine, offline (--network none). It drives the trooper's real
# stageFromAgent (compiled, from /opt/trooper) inside the image, as root with `as` = the agent uid,
# the way the push container runs it, against agent-owned working copies at /home/agent/repo and
# /home/agent/repo2 that plant everything an agent could use to make the staging fetch act:
#   - a partial clone (blob:none) whose promisor remote is an observer that records every call, with
#     the staged branch's blob missing, so only a lazy fetch could supply it;
#   - core.fsmonitor and real hooks (reference-transaction, pre-commit, post-commit, post-checkout, via
#     core.hooksPath) that write a marker if run; a control proves they fire when git runs them.
# Asserted: the observer, fsmonitor and hook markers are never written; the partial copy's staging
# fails with the lazy-fetch refusal (explicit text); the complete copy stages and the head equals the
# agent's commit. A raw `git cat-file` lazy fetch is the positive control: it does reach the
# observer, so a missing marker means something.
# Note: the image's git (2.39.x) already refuses lazy fetch inside upload-pack by itself, so the
# GIT_NO_LAZY_FETCH in HARDENED_UPLOAD_PACK is defence in depth; this test guards the end-to-end
# staging path, and the unit test pins the hardened command's exact text.
# Builds jumpmaster-trooper:dev first (cached when current). Exits non-zero on failure.
set -euo pipefail
cd "$(dirname "$0")/../../.."
docker build -q --build-arg SOURCE_URL="${SOURCE_URL:-}" -t jumpmaster-trooper:dev -f images/trooper/Dockerfile . >/dev/null
echo "lazy-fetch e2e: Docker Engine $(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"

# Setup, as the agent uid.
# shellcheck disable=SC2016
SETUP='
set -eu
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
M=/tmp/jm-10001/m; mkdir -p "$M"
T=/tmp/jm-10001/t; mkdir -p "$T"
git init -q --bare "$T/origin.git"
git -C "$T/origin.git" config uploadpack.allowFilter true
git -C "$T/origin.git" config uploadpack.allowAnySHA1InWant true
git init -q "$T/seed"
echo secret-blob-content > "$T/seed/f.txt"
git -C "$T/seed" add f.txt && git -C "$T/seed" commit -q -m seed
git -C "$T/seed" push -q "$T/origin.git" HEAD:refs/heads/work
# Observers: each records that it ran.
printf "#!/bin/sh\necho called >> %s/promisor\nexec git-upload-pack \"\$@\"\n" "$M" > "$T/rec.sh"
printf "#!/bin/sh\necho called >> %s/fsmonitor\nexit 0\n" "$M" > "$T/fsm.sh"
printf "#!/bin/sh\necho called >> %s/hook\nexit 0\n" "$M" > "$T/hook.sh"
chmod +x "$T/rec.sh" "$T/fsm.sh" "$T/hook.sh"
plant() { # repo
  git -C "$1" config core.fsmonitor "$T/fsm.sh"
  mkdir -p "$T/hooks"
  for h in reference-transaction pre-commit post-commit post-checkout; do
    cp "$T/hook.sh" "$T/hooks/$h"
  done
  git -C "$1" config core.hooksPath "$T/hooks"
}
# 1) Partial clone: the blob of work is missing and its promisor remote is the observer.
R=/home/agent/repo
git clone -q --no-checkout --filter=blob:none "file://$T/origin.git" "$R"
git -C "$R" config remote.origin.uploadpack "$T/rec.sh"
git -C "$R" branch work origin/work
plant "$R"
BLOB=$(git -C "$T/origin.git" rev-parse work:f.txt)
# Control: a raw lazy fetch reaches the observer.
git -C "$R" cat-file -p "$BLOB" >/dev/null 2>&1 || true
[ -f "$M/promisor" ] || { echo "FAIL: control: a lazy fetch never reached the observer" >&2; exit 1; }
echo "control: a raw lazy fetch reaches the promisor observer: ok"
# The control fetched the blob; recreate the partial state and reset the markers.
rm -rf "$R"; mkdir "$R"
git clone -q --no-checkout --filter=blob:none "file://$T/origin.git" "$R"
git -C "$R" config remote.origin.uploadpack "$T/rec.sh"
git -C "$R" branch work origin/work
plant "$R"
rm -f "$M"/*
# 2) A complete working copy with the same planted fsmonitor and hooks.
R2=/home/agent/repo2
git clone -q "file://$T/origin.git" "$R2"
git -C "$R2" checkout -q -b work2 origin/work
plant "$R2"
# Controls: the planted fsmonitor and hooks do fire when git runs them in the agent copy, so their
# absence after staging means something. status runs the fsmonitor; a commit runs the hooks.
git -C "$R2" status >/dev/null 2>&1 || true
[ -f "$M/fsmonitor" ] || { echo "FAIL: control: the planted fsmonitor never ran" >&2; exit 1; }
git -C "$R2" commit -q --allow-empty -m control
[ -f "$M/hook" ] || { echo "FAIL: control: the planted hooks never ran" >&2; exit 1; }
echo "control: planted fsmonitor and hooks fire in the agent copy: ok"
rm -f "$M"/*
git -C "$R2" rev-parse work2 > "$T/head2"
'
# shellcheck disable=SC2016
STAGE='
import { stageFromAgent, setWorkRoot } from "/opt/trooper/git.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
setWorkRoot("/work");
const as = { uid: 10001, gid: 10001, home: "/home/agent" };
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
const markers = () => (existsSync("/tmp/jm-10001/m") ? readdirSync("/tmp/jm-10001/m") : []);
// Partial copy: staging must fail, with the refusal text, and reach nothing.
let err = null;
try { await stageFromAgent("/home/agent/repo", "work", { as, sweep: () => {} }); } catch (e) { err = e; }
if (!err) fail("staging a partial clone with a missing blob succeeded");
const msg = String(err.message);
if (!/lazy fetching disabled/.test(msg)) fail("unexpected staging failure: " + msg.slice(0, 400));
if (!/\(exit 128\)/.test(msg)) fail("expected exit 128, got: " + msg.slice(0, 400));
if (markers().length) fail("staging the partial clone ran planted code or the promisor: " + markers());
console.log("observed staging error: " + msg.replace(/\s+/g, " ").slice(0, 300));
console.log("partial clone: staging refused (exit 128, lazy fetching disabled), no marker: ok");
// Complete copy: staging succeeds with the agent head, and plants stay dormant.
const want = readFileSync("/tmp/jm-10001/t/head2", "utf8").trim();
const r = await stageFromAgent("/home/agent/repo2", "work2", { as, sweep: () => {} });
if (!("head" in r)) fail("complete copy staged nothing: " + JSON.stringify(r));
if (r.head !== want) fail("staged head " + r.head + " != " + want);
if (markers().length) fail("staging the complete copy ran planted code: " + markers());
console.log("complete copy: staged head " + r.head.slice(0, 12) + " equals the agent commit, no marker: ok");
console.log("PASS");
'
docker run --rm --network none --entrypoint sh jumpmaster-trooper:dev -c '
set -eu
setpriv --reuid=10001 --regid=10001 --clear-groups env HOME=/home/agent sh -c "$1"
cd /opt/trooper && node --input-type=module -e "$2"
' sh "$SETUP" "$STAGE"
