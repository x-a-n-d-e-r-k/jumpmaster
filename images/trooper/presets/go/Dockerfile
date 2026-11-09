# The go preset: the trooper image plus the Go toolchain from the official image. Build it FROM
# the trooper image:
#   docker build --build-arg BASE=<trooper image> -f images/trooper/presets/go/Dockerfile .
# The default BASE is the plain Node image the trooper starts from, so a build that forgets BASE
# fails at the check below instead of producing an image without the trooper.
ARG BASE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

# Go 1.27.3 (released 2026-10-20). A named stage, so Dependabot bumps the digest.
FROM golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS go

FROM ${BASE}
ARG SOURCE_URL
LABEL org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.title="jumpmaster-trooper-go"
RUN test -f /opt/trooper/main.js || { echo "BASE must be the jumpmaster trooper image" >&2; exit 1; }
COPY --from=go /usr/local/go /usr/local/go
# GOTOOLCHAIN=local: go runs this toolchain only and never downloads another (a `toolchain` line
# asking for a newer Go fails instead), so egress needs no toolchain host.
ENV PATH=/usr/local/go/bin:${PATH} \
    GOTOOLCHAIN=local
# Root-owned and read-only to both identities: the agent can't change a binary the gate runs.
# A login shell rebuilds PATH from /etc/profile: the profile.d snippet puts Go back.
RUN chown -R root:root /usr/local/go \
 && chmod -R go-w /usr/local/go \
 && go version \
 && printf '%s\n' 'case ":$PATH:" in *:/usr/local/go/bin:*) ;; *) PATH="/usr/local/go/bin:$PATH" ;; esac' > /etc/profile.d/jm-go.sh \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +
