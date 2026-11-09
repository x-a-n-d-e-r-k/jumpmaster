# Release runbook

For the repository owner. A release is a version tag on `main`. Pushing it runs
`.github/workflows/release.yml`, which:

1. **guard**: refuses the tag unless it is `vX.Y.Z` or `vX.Y.Z-rc.N` and its commit is on `main`
   (`git merge-base --is-ancestor "$GITHUB_SHA" origin/main`). Nothing else runs if it fails.
2. **troopers**: builds the trooper (the node preset), the python, go and jvm presets (`FROM` the
   trooper just built, by digest) and the egress proxy, each with an SBOM, `provenance: mode=max`
   and the `org.opencontainers.image.source` label, and pushes them to `ghcr.io/<owner>` by digest.
3. **apps**: builds the server with the release's `images.lock.json` baked in, and the stick with
   the release version, this repository as its trusted signer and the release's egress proxy
   digest, and pushes both by digest.
4. **sign**: signs every image by its index digest with cosign keyless, then verifies each with
   exactly the flags the stick uses. Renders `compose.yaml` from `deploy/compose.yaml.tmpl`, writes
   `images.lock.json` and `SHA256SUMS`, and signs `SHA256SUMS` (`SHA256SUMS.sigstore.json`).
5. **publish**: creates the GitHub Release with those four files. An `-rc.N` tag is a pre-release.

Only `sign` holds `id-token: write`. Only `publish` holds `contents: write`.

## Owner steps

These change repository or package settings. Nobody else does them.

| When | Step |
|---|---|
| Once, before the first tag | Add a **tag ruleset**: Settings → Rules → Rulesets → New tag ruleset. Target `refs/tags/v*`. Restrict creations, updates and deletions. Bypass list: the owner only (no other account, the approving agent account included). |
| Once, before the first tag | Settings → Actions → General: allow GitHub Actions, and under "Workflow permissions" keep the default read-only `GITHUB_TOKEN`. The workflow asks for `packages: write`, `id-token: write` and `contents: write` per job, which a repository workflow may do. If an organisation policy blocks `id-token: write` (OIDC), allow it. |
| First pre-release | Push `v0.4.0-rc.1` (below). |
| After the first push | For each package (server, stick, egress, trooper, and the python, go and jvm presets): Packages → the package → Package settings → **Change visibility → Public**. Check "Repository source" shows this repository: the `org.opencontainers.image.source` label links it. If a package isn't linked, use "Connect repository". |
| Every release after that | Push the version tag. |

## Dry run

Actions → Release → Run workflow, on any branch. `guard`, `sign` and `publish` are skipped (a
`workflow_dispatch` never logs in to GHCR, signs or publishes). The images are built exactly as
for a release and pushed to a registry that lives only inside the job, so the presets still build
`FROM` the trooper by digest. Expected: `troopers` and `apps` green, nothing on GHCR.

## Cutting a release

From a clean checkout of `main` that includes the commit you want:

```sh
git fetch origin
git tag v0.4.0-rc.1 origin/main        # or a commit on main
git push origin v0.4.0-rc.1
```

A final release is the same with `vX.Y.Z`. Tags other than these two shapes don't trigger the
workflow, and `guard` refuses any that slip through. Don't move or reuse a tag: the ruleset blocks
it, and every image is addressed by digest anyway.

## Checking a release

From a machine that is not logged in to GHCR (`docker logout ghcr.io` first):

1. The release lists `compose.yaml`, `images.lock.json`, `SHA256SUMS` and
   `SHA256SUMS.sigstore.json`. Verify the files and each image with the commands in
   [SECURITY.md](../../SECURITY.md#verifying-a-release).
2. Anonymous pulls work for every image in `images.lock.json`:
   `docker pull ghcr.io/x-a-n-d-e-r-k/jumpmaster-server@sha256:<digest>`. A `denied` or
   `unauthorized` answer means the package is still private.
3. The SBOM and provenance are attached:
   `docker buildx imagetools inspect ghcr.io/x-a-n-d-e-r-k/jumpmaster-server@sha256:<digest> --format '{{ json .SBOM }}'`
   (and `.Provenance`).
4. Once, as a negative rehearsal: create an rc tag on a commit that is not on `main` (a scratch
   branch), push it, and confirm `guard` fails and nothing is built. Then delete the tag
   (`git push origin :refs/tags/<tag>`, which the ruleset lets only the owner do).

## The signing identity

The stick, `SECURITY.md` and the workflow's own check all verify this, for this repository:

- certificate identity, matched as an anchored regexp:
  `^https://github\.com/x-a-n-d-e-r-k/jumpmaster/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$`
- OIDC issuer: `https://token.actions.githubusercontent.com`
- workflow trigger: `push`
- workflow repository: `x-a-n-d-e-r-k/jumpmaster`

A signature from any other workflow file, branch, trigger or repository does not verify.

### If the workflow path or the repository moves

The identity names the workflow file and the repository, so renaming `release.yml`, moving it, or
transferring or renaming the repository changes what a new release is signed as. Sticks verify
with the identity built into their image, so:

1. Release a stick built with the new identity (the stick image takes the repository as the
   `RELEASE_REPOSITORY` build argument; a path change also needs the code's identity changed).
2. Old sticks keep accepting only the old identity until the operator upgrades them, so publish
   that stick before any image that only the new identity signs, and tell operators to upgrade.

## After the first release

The preset Dockerfiles default `ARG BASE` to the plain Node image, a placeholder that their own
build check refuses. Once a trooper is published, record it in `images/published.json`
(`version`, `registry` such as `ghcr.io/x-a-n-d-e-r-k`, and `images` with the
`jumpmaster-trooper` digest) and set each preset's `ARG BASE` default to
`<registry>/jumpmaster-trooper@<digest>`, in one pull request. `images/images.test.ts` fails if the
two disagree.

## Images, the lock and `JM_DEV_IMAGES`

A zone names its image with `image` (any reference, but a digest under signed images) or a
`preset` (`node`, `python`, `go`, `jvm`). The server resolves a preset through the image lock at
`/app/images.lock.json`, which only a release-built server image has: it maps each image name to
the release's index digest under the release's registry, so a preset zone runs
`ghcr.io/<owner>/jumpmaster-trooper-<preset>@sha256:…`.

- Without a lock (a server run from a checkout, or an image built without `IMAGES_LOCK`), a preset
  zone is a config error unless it sets `image`, or the server runs with `JM_DEV_IMAGES=1`. That
  flag resolves presets to locally built `jumpmaster-trooper[-<preset>]:dev` tags, for development
  only: a tag is mutable, and a zone that requires signed images refuses it.
- With a lock that lacks the preset's image, `JM_DEV_IMAGES=1` does not help: the zone must set
  `image`, or the server must come from a release whose lock has it.
- The release's `images.lock.json` asset is the same map plus the server and stick images.
