FROM jumpmaster-trooper:dev
# Test layer only: replaces the Claude CLI with a probe that answers like stream-json, and adds the
# egress probe the egress e2e runs as a gate.
RUN rm -f /usr/local/bin/claude
COPY fake-claude /usr/local/bin/claude
COPY egress-probe.js /usr/local/lib/jm-e2e/egress-probe.js
