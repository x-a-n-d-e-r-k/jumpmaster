# The go preset: the trooper image plus the Go toolchain from the official image. Build it FROM
# the trooper image:
#   docker build --build-arg BASE=<trooper image> -f images/trooper/presets/go/Dockerfile .
# The default BASE is the plain Node image the trooper starts from, so a build that forgets BASE
# fails at the check below instead of producing an image without the trooper.
ARG BASE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${BASE}
ARG SOURCE_URL
LABEL org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.title="jumpmaster-trooper-go"
RUN test -f /opt/trooper/main.js || { echo "BASE must be the jumpmaster trooper image" >&2; exit 1; }
# Go 1.27.3 (released 2026-10-20).
COPY --from=golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 /usr/local/go /usr/local/go
ENV PATH=/usr/local/go/bin:${PATH}
RUN go version \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +
