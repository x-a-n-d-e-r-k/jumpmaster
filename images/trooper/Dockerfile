FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/protocol packages/protocol
COPY apps/server apps/server
COPY apps/trooper apps/trooper
RUN npm ci
RUN npx tsc -b packages/protocol && npx tsc -b apps/trooper \
 && mkdir -p /out/node_modules/@jumpmaster/protocol \
 && cp -r apps/trooper/dist/. /out/ \
 && printf '{"type":"module"}\n' > /out/package.json \
 && cp -r node_modules/zod /out/node_modules/zod \
 && cp -r packages/protocol/package.json packages/protocol/dist /out/node_modules/@jumpmaster/protocol/

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm i -g @anthropic-ai/claude-code@2.1.302 \
 && npm cache clean --force
COPY --from=build /out /opt/trooper
RUN useradd --create-home --shell /bin/bash trooper
USER trooper
ENV CLAUDE_CONFIG_DIR=/home/trooper/.claude
WORKDIR /home/trooper
ENTRYPOINT ["node","/opt/trooper/main.js","/run/jumpmaster/payload.json"]
