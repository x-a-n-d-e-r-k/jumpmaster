# Test layer only: a sidecar for the egress e2e that listens on 5432 and has busybox's network
# tools, so the e2e can check DNS and routes from a service container on a drop network.
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
ARG SOURCE_URL
LABEL org.opencontainers.image.source="${SOURCE_URL}"
CMD ["sh", "-c", "while true; do nc -l -p 5432 -e true; done"]
