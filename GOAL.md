# Jumpmaster goal

## Lighthouse

Jumpmaster is a self-hosted software factory that takes a repository's agent-ready issues to
merged pull requests with no person in the loop, safely, and is easy for a first-time operator to
install and run.

## Objectives

The current milestone is M5: GitHub App authentication, built as specified in
`docs/superpowers/specs/2026-11-13-github-app-auth.md` (the spec). Each objective below is one
task of the spec's §13. Read the named sections of the spec before planning; the spec, the spike
results in `docs/spikes/2026-11-14-github-app.md`, and the push container already on `main`
(spec Task 4) are the ground truth. File issues small enough for one drop each, in dependency
order, each naming the spec sections it implements.

### Broker and JWT (spec Task 5)

`apps/server/src/forge/github-app.ts`: sign the app JWT, mint installation tokens narrowed to the
zone's repository and to the permission subset of each use in §4.2's table, cache the server's own
tokens and re-mint them with under ten minutes left, mint per-drop read tokens and per-push write
tokens and revoke them at drop end or on the push result, suspend the installation for the kill
switch, and register every minted token and the key with redaction. The spike found that
suspension kills live tokens within seconds, so minted tokens are not stored in the vault (§4.2).
Tests run against a fake GitHub; nothing calls github.com.

### Forge identity (spec Task 6)

§4.3: a token provider and the forge's identity in `GitHubForge`; every caller that reads the
token's account; `viewerIsAdmin`; ruleset bypass per ruleset with the absent-field fallback;
`repoAccess`; the bot login set in `ours()` and `flow/reconcile.ts`; the check-runs read.

### Vault and credential resolution (spec Task 7)

§4.4: `github-app/<owner>/<role>` vault entries, credential references, app-first resolution,
`testCredential` and fingerprints for apps, PEM scrubbing, `pairFor` by credential kind, the read
source.

### Manifest flow (spec Task 8)

§4.1: the owner choice (personal or organization, preselected from the repository), one app pair
per owner, the manifest builder that refuses `administration` and `workflows`, single-use state,
immediate redemption with log scrubbing, the conversion checks, the Finish confirmation, the
install link and installation discovery; the wizard's and Settings → Credentials' buttons.

### Doctor and guidance (spec Task 9)

§6's app column, the slug check, the `jumpmaster-merge` ruleset file, CODEOWNERS text for app
reviewers, `recommendIdentity` for apps, and token links for starter mode and "Use tokens
instead". `forge.actions-approval` may be deferred.

### Runbooks and SECURITY.md (spec Task 10)

Install (GitHub Apps first for two-bot, tokens for starter and as the alternative), operate (key
rotation, adding a repository or an owner, pending pushes), troubleshooting by check id, the key's
reach.

### GitLab adapter (spec Task 12)

§9: the bootstrap token, project-token minting with `self_rotate`, the per-zone credential kinds.

## Constraints

- The spec wins over any issue, plan or comment. Where the spec is silent, choose the option that
  keeps an operator's work lowest and say so in the PR.
- Starter mode stays on personal access tokens; GitHub Apps are for two-bot mode only. PAT mode
  must keep working unchanged at every step: no issue may break an existing PAT install.
- No manifest, token or code path ever asks for `administration` or `workflows`.
- No write token in any container an agent ran in. Per-drop and per-push tokens are narrowed to
  the drop's repository.
- Never log, return or render a token, a private key or a client secret. Tests prove it for every
  new path.
- Tests never reach github.com or gitlab.com; use the existing fakes or nock.
- One concern per issue and per pull request; each issue states its acceptance criteria and
  required tests.

## Non-goals

- Migrating existing two-bot PAT installs to apps (spec Task 11): deferred until such an install
  exists.
- Webhooks: Jumpmaster polls.
- Public GitHub Apps.
