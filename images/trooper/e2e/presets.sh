#!/usr/bin/env bash
# Preset e2e: builds the trooper image and the python, go and jvm presets FROM it, then checks each
# toolchain twice: as the agent user directly, and as the gate user through a real review drop
# (the trooper's own environment scrubbing and privilege drop), with the fake Claude CLI mounted in
# place of the real one. Exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/../../.."
REPO="${E2E_REPO:-x-a-n-d-e-r-k/jumpmaster}"
BRANCH="${E2E_BRANCH:-main}"
SOURCE_URL="${SOURCE_URL:-}"
FAKE="$PWD/images/trooper/e2e/fake-claude"
echo "presets: Docker Engine $(docker version --format '{{.Server.Version}}')"
SHA="$(git ls-remote "https://github.com/${REPO}.git" "refs/heads/${BRANCH}" | cut -f1)"
[ -n "$SHA" ] || { echo "cannot resolve ${REPO}@${BRANCH}" >&2; exit 1; }

docker build -q --build-arg SOURCE_URL="$SOURCE_URL" -t jumpmaster-trooper:dev -f images/trooper/Dockerfile . >/dev/null
docker build -q --build-arg SOURCE_URL="$SOURCE_URL" --build-arg BASE=jumpmaster-trooper:dev -t jumpmaster-trooper-python:dev -f images/trooper/presets/python/Dockerfile . >/dev/null
docker build -q --build-arg SOURCE_URL="$SOURCE_URL" --build-arg BASE=jumpmaster-trooper:dev -t jumpmaster-trooper-go:dev -f images/trooper/presets/go/Dockerfile . >/dev/null
docker build -q --build-arg SOURCE_URL="$SOURCE_URL" --build-arg BASE=jumpmaster-trooper:dev -t jumpmaster-trooper-jvm:dev -f images/trooper/presets/jvm/Dockerfile . >/dev/null
# A zone image as operators write one: `npm i -g pnpm@…` over the trooper. Corepack shims in
# /usr/local/bin made this fail with EEXIST.
if ! built="$(docker build -q -t jumpmaster-trooper-globalpnpm:dev -f images/trooper/e2e/global-pnpm.Dockerfile images/trooper/e2e 2>&1)"; then
  echo "FAIL: global pnpm zone image does not build: $(tail -c 600 <<<"$built")" >&2
  exit 1
fi
echo 'global pnpm zone image builds: ok'

PY='python3 --version && python3.12 --version && uv --version'
# A real build with the shipped toolchain only (GOTOOLCHAIN=local, no module downloads).
# shellcheck disable=SC2016 # expanded by the container's sh
GO='go version && test "$(go env GOTOOLCHAIN)" = local && d="$(mktemp -d)" && cd "$d" && printf "module example.test/hello\n\ngo 1.21\n" > go.mod && printf "package main\n\nfunc main() { println(\"go-build-ok\") }\n" > main.go && go build -o hello . && ./hello'
JVM='java -version && mvn -v'
# The node preset (the trooper itself): Corepack runs the pnpm and yarn a repository's
# `packageManager` declares (hash-pinned, fetched and checked on first use), from its own shim
# directory, after /usr/local/bin on PATH.
PNPM_PM='pnpm@10.18.3+sha512.bbd16e6d7286fd7e01f6b3c0b3c932cda2965c06a908328f74663f10a9aea51f1129eea615134bf992831b009eabe167ecb7008b597f40ff9bc75946aadfb08d'
YARN_PM='yarn@1.22.22+sha512.a6b2f7906b721bba3d67d4aff083df04dad64c399707841b7acf00f6b133b7ac24255f2652fa22ae3534329dc6180534e98d17432037ff6fd140556e2bb3137e'
# shellcheck disable=SC2016 # expanded by the container's sh
NODE='command -v pnpm && command -v yarn && d="$(mktemp -d)" && cd "$d" && mkdir p y && printf "{\"packageManager\":\"'"$PNPM_PM"'\"}" > p/package.json && printf "{\"packageManager\":\"'"$YARN_PM"'\"}" > y/package.json && (cd p && echo "pnpm=$(pnpm --version)") && (cd y && echo "yarn=$(yarn --version)") && echo "login=$(sh -lc "command -v pnpm")"'
NODE_OK='/opt/corepack/bin/pnpm./opt/corepack/bin/yarn.*pnpm=10\.18\.3.*yarn=1\.22\.22.*login=/opt/corepack/bin/pnpm'
# With a global npm pnpm the zone's pnpm wins everywhere, even over a `packageManager` pin
# (pnpm 9 doesn't switch versions); yarn still comes from Corepack.
# shellcheck disable=SC2016 # expanded by the container's sh
GLOBAL='command -v pnpm && command -v yarn && cd "$(mktemp -d)" && echo "pnpm=$(pnpm --version)" && echo "login=$(sh -lc "command -v pnpm")"'
GLOBAL_OK='/usr/local/bin/pnpm./opt/corepack/bin/yarn.*pnpm=9\.15\.4.*login=/usr/local/bin/pnpm'
HARDEN=(--cap-drop ALL --security-opt no-new-privileges --pids-limit 512)

# As the agent user, with the agent's home, as Claude's tools would run.
expect() { # name, pattern, output
  if grep -Eq "$2" <<<"$3"; then echo "$1: ok"; else echo "FAIL: $1: $3" >&2; exit 1; fi
}
out="$(docker run --rm "${HARDEN[@]}" --user 10001:10001 -e HOME=/home/agent --entrypoint sh jumpmaster-trooper-python:dev -c "$PY && uv python find 3.12 && python3.12 -V" 2>&1 || true)"
expect 'python as agent' 'Python 3\.11\..*Python 3\.12\..*uv [0-9.]+.*/usr/local/bin/python3\.12.*Python 3\.12\.' "$(tr '\n' ' ' <<<"$out")"
out="$(docker run --rm "${HARDEN[@]}" --user 10001:10001 -e HOME=/home/agent --entrypoint sh jumpmaster-trooper-go:dev -c "$GO" 2>&1 || true)"
expect 'go as agent' '^go version go1\..*go-build-ok' "$(tr '\n' ' ' <<<"$out")"
out="$(docker run --rm "${HARDEN[@]}" --user 10001:10001 -e HOME=/home/agent --entrypoint sh jumpmaster-trooper-jvm:dev -c "$JVM" 2>&1 || true)"
expect 'jvm as agent' 'openjdk version "21\..*Apache Maven 3\.' "$(tr '\n' ' ' <<<"$out")"
out="$(docker run --rm "${HARDEN[@]}" --user 10001:10001 -e HOME=/home/agent --entrypoint sh jumpmaster-trooper:dev -c "$NODE" 2>&1 || true)"
expect 'node as agent' "$NODE_OK" "$(tr '\n' ' ' <<<"$out")"
out="$(docker run --rm "${HARDEN[@]}" --user 10001:10001 -e HOME=/home/agent --entrypoint sh jumpmaster-trooper-globalpnpm:dev -c "$GLOBAL" 2>&1 || true)"
expect 'global pnpm as agent' "$GLOBAL_OK" "$(tr '\n' ' ' <<<"$out")"

# The agent can't write anything in a toolchain the gate runs (a world-writable file there would
# let uid 10001 change a binary uid 10002 executes). `find -writable` checks as the calling user.
# shellcheck disable=SC2016 # expanded by the container's sh, not here
WRITABLE='found="$(find "$@" -writable -print 2>&1 | head -5)"; [ -z "$found" ] && echo none-writable || echo "$found"'
out="$(docker run --rm "${HARDEN[@]}" --user 10001:10001 -e HOME=/home/agent --entrypoint sh jumpmaster-trooper-python:dev -c "$WRITABLE" sh /opt/uv /usr/local/bin/uv /usr/local/bin/uvx 2>&1 || true)"
expect 'python toolchain read-only to agent' '^none-writable$' "$out"
out="$(docker run --rm "${HARDEN[@]}" --user 10001:10001 -e HOME=/home/agent --entrypoint sh jumpmaster-trooper-go:dev -c "$WRITABLE" sh /usr/local/go 2>&1 || true)"
expect 'go toolchain read-only to agent' '^none-writable$' "$out"
out="$(docker run --rm "${HARDEN[@]}" --user 10001:10001 -e HOME=/home/agent --entrypoint sh jumpmaster-trooper-jvm:dev -c "$WRITABLE" sh /opt/java/openjdk /opt/maven 2>&1 || true)"
expect 'jvm toolchain read-only to agent' '^none-writable$' "$out"

# As the gate user: one review drop whose only gate runs the probe.
payload() { # gate command
  node -e '
const [repo, branch, sha, run] = process.argv.slice(1);
const [owner, name] = repo.split("/");
process.stdout.write(JSON.stringify({ protocol: 1, dropId: "e2e-preset", epoch: 1, role: "review",
  repo: { owner, name, defaultBranch: branch }, issue: { number: 1, title: "e2e", body: "e2e" },
  branch, pr: { number: 1, branch, headSha: sha }, gates: [{ name: "toolchain", run, timeoutMinutes: 5 }],
  model: "m", maxTurns: 1, promptVersion: "e2e", prompt: "review", image: "jumpmaster-trooper:dev",
  protectedPaths: [], credentials: { claudeToken: "sk-ant-oat01-E2EDUMMYDUMMYDUMMYDUMMY" } }));
' "$REPO" "$BRANCH" "$SHA" "$1"
}
gate_ok() { # name, pattern, output
  # shellcheck disable=SC2016 # a JavaScript template literal, not a shell expansion
  node -e '
const line = process.argv[2].split("\n").find((l) => l.startsWith("JM_RESULT "));
const g = line ? JSON.parse(line.slice(10)).gates?.[0] : undefined;
const ok = g?.exitCode === 0 && new RegExp(process.argv[3], "s").test(g.outputTail);
console.log(ok ? `${process.argv[1]}: ok` : `FAIL: ${process.argv[1]}: ${JSON.stringify(g ?? line ?? "no result").slice(0, 600)}`);
process.exit(ok ? 0 : 1);' "$1" "$3" "$2"
}
MOUNT=(--mount "type=bind,src=$FAKE,dst=/usr/local/bin/claude,readonly")
TROOPER=(-i --rm --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --security-opt no-new-privileges --pids-limit 512 --ulimit core=0:0)
out="$(payload "$PY" | docker run "${TROOPER[@]}" "${MOUNT[@]}" jumpmaster-trooper-python:dev || true)"
gate_ok 'python as gate' 'Python 3\.11\..*Python 3\.12\..*uv [0-9.]+' "$out"
out="$(payload "$GO" | docker run "${TROOPER[@]}" "${MOUNT[@]}" jumpmaster-trooper-go:dev || true)"
gate_ok 'go as gate' 'go version go1\..*go-build-ok' "$out"
out="$(payload "$JVM" | docker run "${TROOPER[@]}" "${MOUNT[@]}" jumpmaster-trooper-jvm:dev || true)"
gate_ok 'jvm as gate' 'openjdk version "21\..*Apache Maven 3\.' "$out"
out="$(payload "$NODE" | docker run "${TROOPER[@]}" "${MOUNT[@]}" jumpmaster-trooper:dev || true)"
gate_ok 'node as gate' "$NODE_OK" "$out"
out="$(payload "$GLOBAL" | docker run "${TROOPER[@]}" "${MOUNT[@]}" jumpmaster-trooper-globalpnpm:dev || true)"
gate_ok 'global pnpm as gate' "$GLOBAL_OK" "$out"
if grep -q E2EDUMMY <<<"$out"; then echo "FAIL: token in output" >&2; exit 1; fi

docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep -E '^jumpmaster-trooper(-python|-go|-jvm)?:dev ' | sort
echo "presets: pass"
