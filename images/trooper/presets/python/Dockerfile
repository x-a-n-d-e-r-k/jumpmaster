# The python preset: the trooper image plus Debian's python3 (3.11) with venv, a pinned uv, and
# Python 3.12 installed by uv at build time. Build it FROM the trooper image:
#   docker build --build-arg BASE=<trooper image> -f images/trooper/presets/python/Dockerfile .
# The default BASE is the plain Node image the trooper starts from, so a build that forgets BASE
# fails at the check below instead of producing an image without the trooper. Release builds pass
# the trooper's digest. Until the first release, that default is a placeholder: once
# images/published.json lists the released trooper, the default becomes its digest
# (images/images.test.ts checks the two agree; see docs/runbooks/release.md).
ARG BASE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS fetch
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
# uv 0.13.5 (released 2026-10-22), checked against the release's published SHA-256 per platform.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) a=x86_64; sum=f68d291c75783122dad58ab77def0e13f3233f358731db5d6d7e8715603b928f ;; \
      arm64) a=aarch64; sum=4bb69cf95ed13f23713bb7bc09f241896ea0c75b7c557e615a20604b82f9c403 ;; \
      *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/uv.tar.gz "https://github.com/astral-sh/uv/releases/download/0.13.5/uv-${a}-unknown-linux-gnu.tar.gz"; \
    echo "${sum}  /tmp/uv.tar.gz" | sha256sum -c -; \
    mkdir -p /out; \
    tar -xzf /tmp/uv.tar.gz -C /tmp; \
    install -m 0755 "/tmp/uv-${a}-unknown-linux-gnu/uv" "/tmp/uv-${a}-unknown-linux-gnu/uvx" /out/

FROM ${BASE}
ARG SOURCE_URL
LABEL org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.title="jumpmaster-trooper-python"
RUN test -f /opt/trooper/main.js || { echo "BASE must be the jumpmaster trooper image" >&2; exit 1; }
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /out/uv /out/uvx /usr/local/bin/
# Python 3.12.15 (released 2026-09-30); uv checks the download against the SHA-256 it ships for
# it. It is installed outside root's 0700 home, root-owned and world-readable, and linked onto
# PATH, where every user's uv finds it. UV_PYTHON_INSTALL_DIR is set for this install only: at run
# time each user's uv downloads any other Python into its own home, because a shared writable
# directory would let the agent change the interpreter the gate runs.
ENV UV_PYTHON_DOWNLOADS=automatic
RUN UV_PYTHON_INSTALL_DIR=/opt/uv/python uv python install --no-bin 3.12.15 \
 && ln -s "$(UV_PYTHON_INSTALL_DIR=/opt/uv/python uv python find 3.12.15)" /usr/local/bin/python3.12 \
 && chmod -R a+rX,go-w /opt/uv \
 && uv cache clean \
 && rm -rf /root/.cache \
 && python3.12 -V \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +
