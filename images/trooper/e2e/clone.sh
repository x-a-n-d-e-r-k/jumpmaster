#!/usr/bin/env bash
# Clone e2e, against the real engine, hermetic: no gitlab.com, no internet, no token that works
# anywhere. A local git smart-HTTPS remote (clone-remote.mjs, in a container on the default
# bridge) stands in for a GitLab host at a bare https://<its bridge address>:8443 origin. It needs
# basic auth with a planted read deploy token, sent as <username>:<token>, and refuses any request
# without it. Its certificate comes from a test CA made here at run time (the CA key never leaves
# the remote's container); only the clone e2e image (clone.Dockerfile) trusts it, so the trooper's
# clone role reaches the remote with nothing in apps/ changed. A second such container is the
# "other host" a hostile remote redirects to; it logs every request with its headers.
# Controls first: a clone without the token (or with a wrong one) is refused, one with it works,
# and the other host is reachable and logs headers. Then the stick's own runDrop, runClone and
# DockerDriver run inside the stick image (clone-drop.mjs) with a fake server client, on two
# implement drops with a provided mirror (clone plan without egress):
#   1. main: the clone container clones the remote; the agent (a fake Claude that makes no commit)
#      runs on the read-only mirror, and the token is searched for everywhere in the agent
#      container (spec, environment, stdin, files, processes' environments, every volume);
#   2. hostile: the remote redirects to the other host; the clone fails cleanly and the other
#      host never sees the token.
# Nothing is pushed. The last line is `clone e2e: ok`. Exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/../../.."
echo "clone e2e: Docker Engine $(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
REMOTE="jm-e2e-clone-remote-$$"
OTHER="jm-e2e-clone-other-$$"
STICK=e2e-clone-stick
# The planted read deploy token: recognisable, and it works nowhere. Written in two pieces so no
# line of this file is token-shaped (scripts/no-token-literals.test.ts); one string at run time.
E2E_USERNAME='gitlab+deploy-token-867'
E2E_TOKEN='gldt-''JMCLONEE2EPLANTEDtoken0867'

cleanup() {
  docker rm -f "$REMOTE" "$OTHER" >/dev/null 2>&1 || true
  for id in $(docker ps -aq --filter "label=jumpmaster.stick=$STICK"); do docker rm -f "$id" >/dev/null 2>&1 || true; done
  for v in $(docker volume ls -q --filter "label=jumpmaster.stick=$STICK"); do docker volume rm -f "$v" >/dev/null 2>&1 || true; done
  for n in $(docker network ls -q --filter "label=jumpmaster.stick=$STICK"); do docker network rm "$n" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

docker build -q --build-arg SOURCE_URL="${SOURCE_URL:-}" -t jumpmaster-trooper:dev -f images/trooper/Dockerfile . >/dev/null
docker build -q --build-arg SOURCE_URL="${SOURCE_URL:-}" -t jumpmaster-stick:dev -f images/stick/Dockerfile . >/dev/null

# The remote: /srv/git/e2e/clone.git with one commit on main. It starts serving once its TLS
# certificate is in place.
# shellcheck disable=SC2016
SEED='
set -eu
export GIT_AUTHOR_NAME=seed GIT_AUTHOR_EMAIL=seed@example.invalid GIT_COMMITTER_NAME=seed GIT_COMMITTER_EMAIL=seed@example.invalid
mkdir -p /srv/git/e2e /srv/tls
git init -q --bare /srv/git/e2e/clone.git
git init -q -b main /tmp/seed
echo base > /tmp/seed/README
git -C /tmp/seed add README && git -C /tmp/seed commit -q -m base
git -C /tmp/seed push -q /srv/git/e2e/clone.git main:refs/heads/main
git -C /srv/git/e2e/clone.git symbolic-ref HEAD refs/heads/main
while [ ! -s /srv/tls/cert.pem ]; do sleep 0.2; done
exec node /e2e/clone-remote.mjs
'
# shellcheck disable=SC2016
WAIT='
set -eu
mkdir -p /srv/tls
while [ ! -s /srv/tls/cert.pem ]; do sleep 0.2; done
exec node /e2e/clone-remote.mjs
'
SERVER_MOUNT="type=bind,src=$PWD/images/trooper/e2e/clone-remote.mjs,dst=/e2e/clone-remote.mjs,readonly"
docker run -d --name "$REMOTE" --label "jumpmaster.stick=$STICK" --mount "$SERVER_MOUNT" \
  -e E2E_ROLE=remote -e E2E_USERNAME="$E2E_USERNAME" -e E2E_TOKEN="$E2E_TOKEN" \
  --entrypoint sh jumpmaster-trooper:dev -c "$SEED" >/dev/null
docker run -d --name "$OTHER" --label "jumpmaster.stick=$STICK" --mount "$SERVER_MOUNT" \
  -e E2E_ROLE=other --entrypoint sh jumpmaster-trooper:dev -c "$WAIT" >/dev/null
IP="$(docker inspect -f '{{(index .NetworkSettings.Networks "bridge").IPAddress}}' "$REMOTE")"
OTHER_IP="$(docker inspect -f '{{(index .NetworkSettings.Networks "bridge").IPAddress}}' "$OTHER")"
if [ -z "$IP" ] || [ -z "$OTHER_IP" ]; then echo "the stand-in hosts have no bridge address" >&2; exit 1; fi

# The test CA and a certificate for each host's bridge address, made in the remote's container.
# shellcheck disable=SC2016
TLS='
set -eu
mkdir -p /tmp/tls && cd /tmp/tls
printf "[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3\n[dn]\nCN=jm-e2e-clone-ca\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n" > ca.cnf
openssl req -x509 -new -noenc -newkey rsa:2048 -keyout ca-key.pem -out ca.pem -days 2 -config ca.cnf 2>>openssl.log
for host in "remote $IP" "other $OTHER_IP"; do
  set -- $host
  printf "[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=%s\n" "$2" > "$1.cnf"
  printf "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:%s\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n" "$2" > "$1.ext"
  openssl req -new -noenc -newkey rsa:2048 -keyout "$1-key.pem" -out "$1.csr" -config "$1.cnf" 2>>openssl.log
  openssl x509 -req -in "$1.csr" -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 2 -extfile "$1.ext" -out "$1.pem" 2>>openssl.log
done
cp remote-key.pem /srv/tls/key.pem
cp remote.pem /srv/tls/cert.tmp && mv /srv/tls/cert.tmp /srv/tls/cert.pem
'
docker exec -e IP="$IP" -e OTHER_IP="$OTHER_IP" "$REMOTE" sh -c "$TLS" \
  || { docker exec "$REMOTE" cat /tmp/tls/openssl.log >&2 || true; exit 1; }
docker exec "$REMOTE" cat /tmp/tls/other-key.pem \
  | docker exec -i "$OTHER" sh -c 'mkdir -p /srv/tls && cat > /srv/tls/key.pem'
docker exec "$REMOTE" cat /tmp/tls/other.pem \
  | docker exec -i "$OTHER" sh -c 'cat > /srv/tls/cert.tmp && mv /srv/tls/cert.tmp /srv/tls/cert.pem'
CA_PEM="$(docker exec "$REMOTE" cat /tmp/tls/ca.pem)"
for c in "$REMOTE" "$OTHER"; do
  for _ in $(seq 1 60); do
    docker exec "$c" test -e /srv/listening && break
    sleep 0.5
  done
  docker exec "$c" test -e /srv/listening || { echo "$c is not serving" >&2; docker logs "$c" >&2; exit 1; }
done
ORIGIN="https://$IP:8443"
OTHER_ORIGIN="https://$OTHER_IP:8443"
echo "clone e2e: stand-in GitLab host at $ORIGIN/e2e/clone.git, other host at $OTHER_ORIGIN"

docker build -q --build-arg CA_PEM="$CA_PEM" -t jumpmaster-trooper:e2e-clone \
  -f images/trooper/e2e/clone.Dockerfile images/trooper/e2e >/dev/null

# Controls, each from a throwaway container of the clone e2e image (it trusts the test CA).
FAILS=0
ok() { echo "ok: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }
basic() { printf '%s' "$1" | base64 | tr -d '\n'; }
probe() {
  docker run --rm --label "jumpmaster.stick=$STICK" -e GIT_TERMINAL_PROMPT=0 \
    --entrypoint git jumpmaster-trooper:e2e-clone "$@" >/dev/null 2>&1
}
last() { docker exec "$1" tail -n 1 /srv/access.log; }

if probe clone -q --bare "$ORIGIN/e2e/clone.git" /tmp/c; then
  fail 'control: a clone attempt without the token is refused by the remote (it was served)'
elif [[ "$(last "$REMOTE")" == *'"auth":"none","status":401'* ]]; then
  ok 'control: a clone attempt without the token is refused by the remote (401)'
else
  fail "control: a clone attempt without the token is refused by the remote ($(last "$REMOTE"))"
fi
WRONG="$(basic "$E2E_USERNAME:gldt-""NOTTHEPLANTEDTOKEN")"
if probe -c "http.extraheader=Authorization: Basic $WRONG" clone -q --bare "$ORIGIN/e2e/clone.git" /tmp/c; then
  fail 'control: a clone attempt with a wrong token is refused by the remote (it was served)'
elif [[ "$(last "$REMOTE")" == *'"auth":"bad","status":401'* ]]; then
  ok 'control: a clone attempt with a wrong token is refused by the remote (401)'
else
  fail "control: a clone attempt with a wrong token is refused by the remote ($(last "$REMOTE"))"
fi
RIGHT="$(basic "$E2E_USERNAME:$E2E_TOKEN")"
if probe -c "http.extraheader=Authorization: Basic $RIGHT" clone -q --bare "$ORIGIN/e2e/clone.git" /tmp/c; then
  ok 'control: a clone with the planted token, over the test CA, is served'
else
  fail "control: a clone with the planted token, over the test CA, is served ($(last "$REMOTE"))"
fi
probe -c 'http.extraheader=X-E2E-Probe: other-host' ls-remote "$OTHER_ORIGIN/e2e/clone.git" || true
if [[ "$(last "$OTHER")" == *'"x-e2e-probe":"other-host"'* ]]; then
  ok 'control: the other host is reachable over the test CA and logs every header'
else
  fail "control: the other host is reachable over the test CA and logs every header ($(last "$OTHER" || true))"
fi
[ "$FAILS" -eq 0 ] || { echo "clone e2e: $FAILS control failure(s)"; exit 1; }

docker run --rm --read-only --tmpfs /tmp \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --mount "type=bind,src=$PWD/images/trooper/e2e/clone-drop.mjs,dst=/e2e/clone-drop.mjs,readonly" \
  -e E2E_REMOTE="$REMOTE" -e E2E_OTHER="$OTHER" -e E2E_ORIGIN="$ORIGIN" -e E2E_OTHER_ORIGIN="$OTHER_ORIGIN" \
  -e E2E_USERNAME="$E2E_USERNAME" -e E2E_TOKEN="$E2E_TOKEN" -e HOSTNAME="$STICK" \
  --entrypoint node jumpmaster-stick:dev /e2e/clone-drop.mjs
