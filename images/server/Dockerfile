# The Jumpmaster server. It holds the forge and Claude tokens and the database, and runs no repo
# code. No Docker client of any kind: only the stick talks to the engine.
# Run it with a read-only root, a tmpfs at /tmp (SQLite temp files), /data writable and secrets
# passed as *_FILE paths. Compose overrides the user with the host uid that owns the secret files.
FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build
# better-sqlite3 is compiled here from source against the image's own Node headers, so nothing
# is downloaded outside npm's integrity-checked lockfile.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/protocol packages/protocol
COPY apps/server apps/server
# The server reads the role prompts from ../../trooper/prompts relative to its compiled modules.
COPY apps/trooper/prompts apps/trooper/prompts
RUN npm ci --ignore-scripts \
 && npx tsc -b packages/protocol apps/server \
 && cp apps/server/src/db/schema.sql apps/server/dist/db/schema.sql
# The runtime tree: production dependencies of the server workspace only.
WORKDIR /out
RUN cp /src/package.json /src/package-lock.json ./ \
 && mkdir -p packages/protocol apps/server apps/trooper \
 && cp -r /src/packages/protocol/package.json /src/packages/protocol/dist packages/protocol/ \
 && cp -r /src/apps/server/package.json /src/apps/server/dist apps/server/ \
 && cp -r /src/apps/trooper/prompts apps/trooper/prompts \
 && npm_config_build_from_source=true npm_config_nodedir=/usr/local \
    npm ci --omit=dev --workspace=@jumpmaster/server --include-workspace-root=false --foreground-scripts \
 && npm cache clean --force \
 && node -e "new (require('better-sqlite3'))(':memory:').close()" \
 && chmod 0755 apps/server/dist/cli.js

FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ARG SOURCE_URL
LABEL org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.title="jumpmaster-server"
COPY --from=build /out /app
RUN ln -s /app/apps/server/dist/cli.js /usr/local/bin/jumpmaster \
 && install -d -o 10000 -g 10000 -m 0700 /data \
 && install -d -o root -g root -m 0755 /config \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +
# The release's image lock (the release workflow passes it): preset zones resolve to these
# digests. Without it a preset zone needs an explicit image, or JM_DEV_IMAGES=1 for local :dev
# builds. The server's own loader checks it here, so a malformed lock fails the build.
ARG IMAGES_LOCK
RUN if [ -n "$IMAGES_LOCK" ]; then \
      printf '%s\n' "$IMAGES_LOCK" > /app/images.lock.json \
      && chmod 0444 /app/images.lock.json \
      && node --input-type=module -e "const m = await import('/app/apps/server/dist/presets.js'); if (!m.loadImageLock('/app/images.lock.json')) process.exit(1);"; \
    fi
# The release this image belongs to (the release workflow passes it): the doctor's links point at
# that tag's install runbook. Empty in other builds, which link to main.
ARG RELEASE_VERSION
ENV NODE_ENV=production \
    JM_RELEASE_VERSION=${RELEASE_VERSION} \
    JM_CONTAINER=1 \
    TMPDIR=/tmp
WORKDIR /app
USER 10000:10000
EXPOSE 7420
ENTRYPOINT ["jumpmaster"]
CMD ["serve", "/config/jumpmaster.config.json"]
