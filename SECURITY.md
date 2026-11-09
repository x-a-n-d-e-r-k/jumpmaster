# Security Policy

Jumpmaster runs AI agents with write access to source repositories and holds Claude and forge
credentials, so we take security reports seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub's
[private vulnerability reporting](https://github.com/x-a-n-d-e-r-k/jumpmaster/security/advisories/new).

Include what you can: affected version or commit, a description of the issue, steps to reproduce,
and the impact you expect. You should get an acknowledgement within 3 business days. We'll keep
you updated as we investigate and credit you in the advisory unless you'd rather stay anonymous.

## Scope

In scope: the Jumpmaster app, the stick agent, trooper images, the MCP server, and the published
container images. Of particular interest:

- credential exposure (Claude tokens, forge tokens, vault contents)
- prompt injection that lets untrusted issue, PR, or comment text steer an agent
- escaping a drop container or reaching another project's data
- bypassing the orchestrator's merge checks or branch protection

Out of scope: vulnerabilities in Claude Code, GitHub, GitLab, Docker, or Kubernetes themselves —
please report those to their maintainers.

## Verifying a release

Every release image (server, stick, trooper and its python, go and jvm presets, and the egress
proxy) is published to GHCR by digest and signed with [cosign](https://docs.sigstore.dev/) keyless
signing by this repository's release workflow, from a version tag on `main`. The stick checks
the same signature before it runs a trooper or proxy image. Each GitHub Release also carries
`compose.yaml` and `images.lock.json` (every image by digest), a `SHA256SUMS` over them, and
`SHA256SUMS.sigstore.json`, the signature bundle for `SHA256SUMS`.

Check an image (take its digest from the release's `images.lock.json`):

```sh
cosign verify \
  --certificate-identity-regexp '^https://github\.com/x-a-n-d-e-r-k/jumpmaster/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-trigger push \
  --certificate-github-workflow-repository x-a-n-d-e-r-k/jumpmaster \
  ghcr.io/x-a-n-d-e-r-k/jumpmaster-server@sha256:<digest>
```

Check the release files, in the directory you downloaded them to:

```sh
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/x-a-n-d-e-r-k/jumpmaster/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-trigger push \
  --certificate-github-workflow-repository x-a-n-d-e-r-k/jumpmaster \
  SHA256SUMS
sha256sum -c SHA256SUMS
```

Without cosign installed, run it from its own image, pinned by digest (cosign v3.1.4). Prefix
either command with it; for `verify-blob`, the current directory is mounted at `/w`:

```sh
docker run --rm -v "$PWD:/w" -w /w ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d verify ...
```

A signature proves the image was built and signed by `release.yml` in this repository, from a
`push` of a version tag. The workflow refuses a tag whose commit is not on `main`, and only the
repository owner can push version tags.

## Supported versions

Jumpmaster is pre-release. Until 1.0, only the latest commit on `main` is supported.
