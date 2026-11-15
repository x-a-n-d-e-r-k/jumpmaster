#!/usr/bin/env bash
# Push e2e, against the real engine, hermetic: no GitHub, no internet, no token that works anywhere.
# A local bare remote (a git daemon in a container on the default bridge) stands in for GitHub; the
# push e2e image (push.Dockerfile) sends the trooper's https://github.com/ URLs there. Then the
# stick's own runDrop, pushOnce and DockerDriver run inside the stick image (push-drop.mjs) with a
# fake server client, on two implement drops:
#   1. final: completed, gated, and pushed by a push container; the remote has the gated SHA;
#   2. interrupt: stopped at the turn cap; the checkpoint is pushed; the remote has its SHA.
# On each: a core.fsmonitor the agent planted in the working copy never runs in the push container
# (it does run in the agent container: the control); an agent-uid process the agent container left
# is not alive in the push container (agentProcessesAlive 0) when it prints ready; the agent
# container's only mount is the volume; the write token never reaches the agent container; the
# grant is written only after ready; the volume is removed at the end.
# The last line is `push e2e: ok`. Exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/../../.."
echo "push e2e: Docker Engine $(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
REMOTE="jm-e2e-push-remote-$$"
STICK=e2e-push-stick

cleanup() {
  docker rm -f "$REMOTE" >/dev/null 2>&1 || true
  for id in $(docker ps -aq --filter "label=jumpmaster.stick=$STICK"); do docker rm -f "$id" >/dev/null 2>&1 || true; done
  for v in $(docker volume ls -q --filter "label=jumpmaster.stick=$STICK"); do docker volume rm -f "$v" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

docker build -q --build-arg SOURCE_URL="${SOURCE_URL:-}" -t jumpmaster-trooper:dev -f images/trooper/Dockerfile . >/dev/null
docker build -q --build-arg SOURCE_URL="${SOURCE_URL:-}" -t jumpmaster-stick:dev -f images/stick/Dockerfile . >/dev/null

# The bare remote: e2e/push.git with one commit on main, served read-write over git://.
# shellcheck disable=SC2016
SEED='
set -eu
export GIT_AUTHOR_NAME=seed GIT_AUTHOR_EMAIL=seed@example.invalid GIT_COMMITTER_NAME=seed GIT_COMMITTER_EMAIL=seed@example.invalid
mkdir -p /srv/e2e
git init -q --bare /srv/e2e/push.git
git init -q -b main /tmp/seed
echo base > /tmp/seed/README
git -C /tmp/seed add README && git -C /tmp/seed commit -q -m base
git -C /tmp/seed push -q /srv/e2e/push.git main:refs/heads/main
git -C /srv/e2e/push.git symbolic-ref HEAD refs/heads/main
exec git daemon --reuseaddr --export-all --enable=receive-pack --informative-errors --base-path=/srv /srv
'
docker run -d --name "$REMOTE" --label "jumpmaster.stick=$STICK" --entrypoint sh jumpmaster-trooper:dev -c "$SEED" >/dev/null
IP="$(docker inspect -f '{{(index .NetworkSettings.Networks "bridge").IPAddress}}' "$REMOTE")"
[ -n "$IP" ] || { echo "the bare remote has no bridge address" >&2; exit 1; }
for _ in $(seq 1 30); do
  docker exec "$REMOTE" git ls-remote git://127.0.0.1/e2e/push.git >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$REMOTE" git ls-remote git://127.0.0.1/e2e/push.git refs/heads/main
echo "push e2e: bare remote at git://$IP/e2e/push.git"

docker build -q --build-arg REMOTE_HOST="$IP" -t jumpmaster-trooper:e2e-push \
  -f images/trooper/e2e/push.Dockerfile images/trooper/e2e >/dev/null

docker run --rm --read-only --tmpfs /tmp \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --mount "type=bind,src=$PWD/images/trooper/e2e/push-drop.mjs,dst=/e2e/push-drop.mjs,readonly" \
  -e E2E_REMOTE="$REMOTE" -e HOSTNAME="$STICK" \
  --entrypoint node jumpmaster-stick:dev /e2e/push-drop.mjs
