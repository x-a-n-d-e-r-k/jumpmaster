FROM jumpmaster-trooper:dev
# Test layer only, for the clone e2e (clone.sh). It keeps the trooper's own code and labels, and:
#   - trusts the e2e's test CA (CA_PEM, made at run time by clone.sh; its key never leaves the
#     stand-in remote's container) in the system store, so the clone role's git reaches the
#     stand-in GitLab host at its bare https://<bridge address>:8443 origin, with its auth header
#     scoped there as in production. No git wrapper: nothing about the URL or the header changes;
#   - replaces the Claude CLI with fake-claude-clone, which makes no commit and calls nothing.
ARG CA_PEM
RUN test -n "$CA_PEM" && rm -f /usr/local/bin/claude \
 && printf '%s\n' "$CA_PEM" > /usr/local/share/ca-certificates/jm-e2e-clone.crt \
 && update-ca-certificates >/dev/null
COPY fake-claude-clone /usr/local/bin/claude
