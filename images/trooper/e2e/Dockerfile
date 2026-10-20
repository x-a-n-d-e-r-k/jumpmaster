FROM jumpmaster-trooper:dev
# Test layer only: replaces the Claude CLI with a probe that answers like stream-json.
RUN rm -f /usr/local/bin/claude
COPY fake-claude /usr/local/bin/claude
