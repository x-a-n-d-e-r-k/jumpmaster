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

## Supported versions

Jumpmaster is pre-release. Until 1.0, only the latest commit on `main` is supported.
