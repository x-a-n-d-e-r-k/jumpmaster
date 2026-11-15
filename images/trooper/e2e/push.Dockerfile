FROM jumpmaster-trooper:dev
# Test layer only, for the push e2e (push.sh). It keeps the trooper's own code and push label, and:
#   - replaces the Claude CLI with fake-claude-push;
#   - puts a git wrapper ahead of /usr/bin/git that sends every https://github.com/ URL to the
#     e2e's local bare remote over git:// (REMOTE_HOST, the remote container's bridge address), so
#     the run needs no GitHub and no internet. Every other argument reaches the real git unchanged.
ARG REMOTE_HOST
RUN test -n "$REMOTE_HOST" && rm -f /usr/local/bin/claude \
 && printf '%s\n' '#!/bin/sh' \
      'n=$#' \
      'for a in "$@"; do' \
      '  case "$a" in https://github.com/*) a="git://REMOTE_HOST/${a#https://github.com/}" ;; esac' \
      '  set -- "$@" "$a"' \
      'done' \
      'shift "$n"' \
      'exec /usr/bin/git -c protocol.git.allow=always "$@"' \
    | sed "s/REMOTE_HOST/$REMOTE_HOST/" > /usr/local/bin/git \
 && chmod 0755 /usr/local/bin/git
COPY fake-claude-push /usr/local/bin/claude
