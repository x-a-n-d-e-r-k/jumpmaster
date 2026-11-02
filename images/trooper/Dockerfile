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
 && apt-get install -y --no-install-recommends git ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && npm i -g @anthropic-ai/claude-code@2.1.302 \
 && npm cache clean --force
COPY --from=build /out /opt/trooper
# Two unprivileged identities with no shared group: the agent (Claude and its tools) and the gate
# runner. The trooper itself stays root as PID 1 and never runs git inside their trees.
RUN groupadd -g 10001 agent && useradd -u 10001 -g 10001 -d /home/agent -m -s /bin/sh agent \
 && groupadd -g 10002 gate && useradd -u 10002 -g 10002 -d /home/gate -m -s /bin/sh gate \
 && chmod 0711 /home/agent && chmod 0700 /home/gate \
 && install -d -o agent -g agent -m 0700 /home/agent/.claude \
 && install -d -o root -g root -m 0755 /work \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +
ENV JM_CONTAINER=1 \
    JM_WORK_ROOT=/work \
    JM_AGENT_UID=10001 JM_AGENT_GID=10001 JM_AGENT_HOME=/home/agent \
    JM_GATE_UID=10002 JM_GATE_GID=10002 JM_GATE_HOME=/home/gate
WORKDIR /work
# The payload (with credentials) arrives on stdin; no payload file exists in the container.
ENTRYPOINT ["node","/opt/trooper/main.js"]
