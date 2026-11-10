FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/protocol packages/protocol
COPY apps/server apps/server
COPY apps/trooper apps/trooper
# The trooper needs no install scripts (only zod and the protocol package ship); skipping them keeps
# the server's native module (better-sqlite3) from being built or downloaded here.
RUN npm ci --ignore-scripts
RUN npx tsc -b packages/protocol && npx tsc -b apps/trooper \
 && mkdir -p /out/node_modules/@jumpmaster/protocol \
 && cp -r apps/trooper/dist/. /out/ \
 && printf '{"type":"module"}\n' > /out/package.json \
 && cp -r node_modules/zod /out/node_modules/zod \
 && cp -r packages/protocol/package.json packages/protocol/dist /out/node_modules/@jumpmaster/protocol/

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG SOURCE_URL
LABEL org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.title="jumpmaster-trooper" \
      org.jumpmaster.trooper.egress="1"
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/*
# The Claude CLI comes from a lockfile, so every package (the platform binary too) is checked
# against its integrity hash. This image doubles as the node preset: corepack provides pnpm and
# yarn, fetched per user (and checked) on first use, at the version the repository declares.
# The shims live in their own directory, last on PATH, not in /usr/local/bin: a zone image's
# `npm i -g pnpm` (or yarn) then installs without EEXIST and wins. A login shell rebuilds PATH from
# /etc/profile, so profile.d appends the directory there too. The Node image's bundled Yarn 1
# (in /usr/local/bin) goes, or it would shadow Corepack's yarn and ignore `packageManager`.
COPY images/trooper/claude/package.json images/trooper/claude/package-lock.json /opt/claude/
RUN cd /opt/claude \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && ln -s /opt/claude/node_modules/.bin/claude /usr/local/bin/claude \
 && rm -rf /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && install -d -m 0755 /opt/corepack/bin \
 && corepack enable --install-directory /opt/corepack/bin pnpm yarn \
 && printf '%s\n' 'case ":$PATH:" in *:/opt/corepack/bin:*) ;; *) PATH="$PATH:/opt/corepack/bin" ;; esac' > /etc/profile.d/jm-corepack.sh
COPY --from=build /out /opt/trooper
# Two unprivileged identities with no shared group: the agent (Claude and its tools) and the gate
# runner. The trooper itself stays root as PID 1 and never runs git inside their trees.
RUN groupadd -g 10001 agent && useradd -u 10001 -g 10001 -d /home/agent -m -s /bin/sh agent \
 && groupadd -g 10002 gate && useradd -u 10002 -g 10002 -d /home/gate -m -s /bin/sh gate \
 && chmod 0711 /home/agent && chmod 0700 /home/gate \
 && install -d -o agent -g agent -m 0700 /home/agent/.claude \
 && install -d -o agent -g agent -m 0700 /tmp/jm-10001 \
 && install -d -o gate -g gate -m 0700 /tmp/jm-10002 \
 && install -d -o root -g root -m 0755 /work \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +
ENV PATH=${PATH}:/opt/corepack/bin \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    JM_CONTAINER=1 \
    JM_WORK_ROOT=/work \
    JM_AGENT_UID=10001 JM_AGENT_GID=10001 JM_AGENT_HOME=/home/agent \
    JM_GATE_UID=10002 JM_GATE_GID=10002 JM_GATE_HOME=/home/gate
WORKDIR /work
# The payload (with credentials) arrives on stdin; no payload file exists in the container.
ENTRYPOINT ["node","/opt/trooper/main.js"]
