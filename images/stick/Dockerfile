# The Jumpmaster stick: the only container that mounts the Docker socket. It runs as root because
# the socket is root-equivalent on the host anyway (a non-root stick with the socket group is
# deferred). Run it with a read-only root and a tmpfs at /tmp; its only writable state is
# JM_STATE_DIR=/state (the enrollment, the Sigstore TUF root and the verify cache).
# It runs the signed image policy: images only by digest, each pinned or verified with cosign.

# cosign v3.1.4 (released 2026-10-20), from Sigstore's own image pinned by digest. A named stage,
# so Dependabot bumps the digest; the binary is also checked against its SHA-256 below.
FROM ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d AS cosign

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/protocol packages/protocol
COPY apps/stick apps/stick
RUN npm ci --ignore-scripts \
 && npx tsc -b packages/protocol apps/stick
# The runtime tree: production dependencies of the stick workspace only. Its dependencies are plain
# JavaScript (ssh2's optional native helpers are skipped), so no install script runs.
WORKDIR /out
RUN cp /src/package.json /src/package-lock.json ./ \
 && mkdir -p packages/protocol apps/stick \
 && cp -r /src/packages/protocol/package.json /src/packages/protocol/dist packages/protocol/ \
 && cp -r /src/apps/stick/package.json /src/apps/stick/dist apps/stick/ \
 && npm ci --omit=dev --workspace=@jumpmaster/stick --include-workspace-root=false --ignore-scripts \
 && npm cache clean --force \
 && node -e "require('dockerode')"

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG SOURCE_URL
LABEL org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.title="jumpmaster-stick"
COPY --from=build /out /app
# Release metadata (the release workflow passes both): the version the stick reports, and the
# repository whose release workflow it trusts to sign images. A build without them has neither.
ARG RELEASE_VERSION
ARG RELEASE_REPOSITORY
RUN node -e " \
      const v = process.env.RELEASE_VERSION || ''; \
      const r = process.env.RELEASE_REPOSITORY || ''; \
      if (v && !/^[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z.-]+)?$/.test(v)) throw new Error('RELEASE_VERSION ' + v); \
      if (r && !/^[A-Za-z0-9-]+[/][A-Za-z0-9._-]+$/.test(r)) throw new Error('RELEASE_REPOSITORY ' + r); \
      if (v || r) require('fs').writeFileSync('/app/release.json', JSON.stringify({ version: v || null, repository: r || null }) + '\\n', { mode: 0o444 }); \
    "
# cosign (Go) checks TLS against the system store, which the slim Node image lacks (Node carries
# its own): without it every Sigstore call fails, and the stick would refuse every image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=cosign /ko-app/cosign /usr/local/bin/cosign
ARG TARGETARCH
# The SHA-256 of /ko-app/cosign in that image, per platform; the stick refuses to start under the
# signed policy unless `cosign version` reports the same version (apps/stick/src/verify.ts).
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) sum=be06b2d8da722330fa78fd7cd858a74b589b20ab314a7d901e8cefcf387c965d ;; \
      arm64) sum=4ec67587bcf621c50f5309c7301b16033cd0b1b8ce3a3bf0ce945ff61cf0dacb ;; \
      *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    echo "${sum}  /usr/local/bin/cosign" | sha256sum -c -; \
    chown root:root /usr/local/bin/cosign; \
    chmod 0755 /usr/local/bin/cosign; \
    cosign version --json > /tmp/cosign-version.json; \
    node -e "const v = JSON.parse(require('fs').readFileSync('/tmp/cosign-version.json', 'utf8')); if (v.gitVersion !== 'v3.1.4') throw new Error('cosign ' + v.gitVersion)"; \
    rm /tmp/cosign-version.json
RUN install -d -o root -g root -m 0700 /state \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +
# The release's egress proxy, by digest (the release workflow passes it); empty in other builds.
ARG EGRESS_IMAGE
ENV NODE_ENV=production \
    JM_CONTAINER=1 \
    JM_STATE_DIR=/state \
    TUF_ROOT=/state/sigstore \
    JM_IMAGE_POLICY=signed \
    JM_EGRESS_IMAGE=${EGRESS_IMAGE} \
    TMPDIR=/tmp
WORKDIR /app
USER root
ENTRYPOINT ["node", "/app/apps/stick/dist/main.js"]
