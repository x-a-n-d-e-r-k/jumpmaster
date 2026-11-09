FROM jumpmaster-trooper:dev
# Test layer only: a zone image as operators commonly write one, with a global npm install of a
# pinned pnpm over the trooper's Corepack shims. presets.sh builds it and checks that it builds and
# that the global pnpm wins for both users. The tarball is checked against its registry sha512.
RUN cd /tmp && npm pack --silent pnpm@9.15.4 \
 && echo "b2dc20e2fc72b3e18848459b37359a32064663e5627a51e4c74b2c29dd8e8e0491483c3abb40789cfd578bf362fb6ba8261b05f0387d76792ed6e23ea3b1b6a0  pnpm-9.15.4.tgz" | sha512sum -c - \
 && npm i -g --no-audit --no-fund ./pnpm-9.15.4.tgz \
 && rm pnpm-9.15.4.tgz && npm cache clean --force
