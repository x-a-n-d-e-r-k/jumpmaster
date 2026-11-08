# The Jumpmaster stick: the only container that mounts the Docker socket. It runs as root because
# the socket is root-equivalent on the host anyway (a non-root stick with the socket group is
# deferred). Run it with a read-only root and a tmpfs at /tmp; its only writable state is
# JM_STATE_DIR=/state (the enrollment, the Sigstore TUF root and the verify cache).
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
RUN install -d -o root -g root -m 0700 /state \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +
ENV NODE_ENV=production \
    JM_CONTAINER=1 \
    JM_STATE_DIR=/state \
    TUF_ROOT=/state/sigstore \
    TMPDIR=/tmp
WORKDIR /app
USER root
ENTRYPOINT ["node", "/app/apps/stick/dist/main.js"]
