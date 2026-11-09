# The per-drop egress proxy: Node's standard library only, no npm dependency at runtime. The stick
# runs one per drop with a read-only root, no capabilities and no-new-privileges, bound to the
# drop-network address it passes in JM_EGRESS_BIND.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/protocol packages/protocol
COPY apps/egress apps/egress
# Only the protocol's egress module is loaded at runtime (its `egress` subpath imports no zod), so
# the runtime tree carries the protocol's compiled files and no node_modules of its own.
RUN npm ci --ignore-scripts \
 && npx tsc -b packages/protocol apps/egress \
 && mkdir -p /out/node_modules/@jumpmaster/protocol \
 && cp -r apps/egress/dist/. /out/ \
 && printf '{"type":"module"}\n' > /out/package.json \
 && cp -r packages/protocol/package.json packages/protocol/dist /out/node_modules/@jumpmaster/protocol/

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG SOURCE_URL
LABEL org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.title="jumpmaster-egress"
COPY --from=build /out /app
RUN find / -xdev -type f -perm /6000 -exec chmod a-s {} +
ENV NODE_ENV=production
WORKDIR /app
USER 10003:10003
EXPOSE 3128
ENTRYPOINT ["node", "/app/main.js"]
