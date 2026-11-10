# The jvm preset: the trooper image plus a Temurin JDK 21 and Maven. Gradle builds use the
# repository's own wrapper. Build it FROM the trooper image:
#   docker build --build-arg BASE=<trooper image> -f images/trooper/presets/jvm/Dockerfile .
# The default BASE is the plain Node image the trooper starts from, so a build that forgets BASE
# fails at the check below instead of producing an image without the trooper. Until the first
# release, that default is a placeholder: once images/published.json lists the released trooper,
# the default becomes its digest (images/images.test.ts checks the two agree; see
# docs/runbooks/release.md).
ARG BASE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# Temurin JDK 21.0.13+9 (released 2026-10-22). A named stage, so Dependabot bumps the digest.
FROM eclipse-temurin:24.0.2_12-jdk-noble@sha256:dacac8e9a0df0d2bd24e702b4431132875c249930b70555ebd7ca285b5bee684 AS jdk

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS fetch
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Maven 3.9.16 (released 2026-05-17), checked against the SHA-512 Apache publishes for it.
RUN curl -fsSLo /tmp/maven.tar.gz https://archive.apache.org/dist/maven/maven-3/3.9.16/binaries/apache-maven-3.9.16-bin.tar.gz \
 && echo "831a8591fe20c8243b1dbe7d71e3244f31d1665b0804b2e825e38cbbe5ce0cafb8338851f90780735568773e0a6cd07bbec107cda0b896b008b861075358b6f6  /tmp/maven.tar.gz" | sha512sum -c - \
 && mkdir -p /out/maven \
 && tar -xzf /tmp/maven.tar.gz -C /out/maven --strip-components=1

FROM ${BASE}
ARG SOURCE_URL
LABEL org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.title="jumpmaster-trooper-jvm"
RUN test -f /opt/trooper/main.js || { echo "BASE must be the jumpmaster trooper image" >&2; exit 1; }
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
COPY --from=fetch /out/maven /opt/maven
ENV JAVA_HOME=/opt/java/openjdk \
    MAVEN_HOME=/opt/maven \
    PATH=/opt/java/openjdk/bin:/opt/maven/bin:${PATH}
# Root-owned and read-only to both identities: the agent can't change a binary the gate runs.
# A login shell rebuilds PATH from /etc/profile: the profile.d snippet puts Java and Maven back.
RUN chown -R root:root /opt/java/openjdk /opt/maven \
 && chmod -R go-w /opt/java/openjdk /opt/maven \
 && java -version \
 && mvn -v \
 && printf '%s\n' 'case ":$PATH:" in *:/opt/java/openjdk/bin:*) ;; *) PATH="/opt/java/openjdk/bin:/opt/maven/bin:$PATH" ;; esac' > /etc/profile.d/jm-jvm.sh \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +
