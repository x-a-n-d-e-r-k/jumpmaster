# Release runbook

For the repository owner. A release is a version tag on `main`. Pushing it runs
`.github/workflows/release.yml`, which:

1. **guard**: refuses the tag unless it is `vX.Y.Z` or `vX.Y.Z-rc.N` and the commit it names
   (`git rev-parse "$GITHUB_SHA^{commit}"`) is on `main` (`git merge-base --is-ancestor`). Nothing
   else runs if it fails.
2. **build** (`.github/workflows/release-build.yml`), natively, with no emulation: every per-arch
   job runs twice, on `ubuntu-24.04` (linux/amd64) and `ubuntu-24.04-arm` (linux/arm64).
   - `troopers` builds the trooper (the node preset), the python, go and jvm presets and the
     egress proxy, each with an SBOM, `provenance: mode=max` and the
     `org.opencontainers.image.source` label, and pushes each to `ghcr.io/<owner>` by digest. Each
     preset builds `FROM` the trooper built earlier in the same job, by that per-arch digest, so
     an arm64 preset always sits on the arm64 trooper.
   - `troopers-index` joins each image's two per-arch digests into one multi-arch index
     (`docker buildx imagetools create`, sources by digest; buildx pushes the index under the tag
     `vX.Y.Z`, a convenience only) and checks the index holds exactly those two images. The
     **index digest** is the image's release digest: it is what is signed, locked and pulled.
   - `apps` (per arch) builds the server with the release's `images.lock.json` (index digests)
     baked in, and the stick with the release version, this repository as its trusted signer and
     the egress proxy's index digest; `apps-index` joins them the same way.
3. **sign**: signs every image by its index digest with cosign keyless, then verifies each with
   exactly the checks the stick makes (the identity flags, and every signed payload naming that
   digest). Renders `compose.yaml` from `deploy/compose.yaml.tmpl`, writes `images.lock.json` and
   `SHA256SUMS`, and signs `SHA256SUMS` (`SHA256SUMS.sigstore.json`).
4. **publish**: creates the GitHub Release with those four files. An `-rc.N` tag is a pre-release.

Only `sign` holds `id-token: write`. Only `build` and `sign` hold `packages: write`, and only
`publish` holds `contents: write`.

## What actually controls a release

A tag push runs the workflow file as it is at the tagged commit, not as it is on `main`. Anyone
who can push a `v*` tag can therefore push a branch whose `release.yml` skips `guard`, tag it, and
get a signature that every stick accepts, permanently (a signature cannot be revoked). `guard`
does not stop that; it only catches the owner tagging the wrong commit. The control is the **tag
ruleset** on `refs/tags/v*`, which must be in place before this workflow is merged to `main`.

This repository already has one: a tag ruleset targeting `refs/tags/v*` that restricts creation,
update and deletion, with only the repository admin role able to bypass it. Keep it that way:

- no account other than the owner may hold admin or maintain on the repository (on an
  organisation-owned repository both roles can edit rulesets; on a user-owned one collaborators
  have write at most), and an automation or agent account gets write only;
- don't add bypass actors to the ruleset, and don't disable it, even briefly.

A fork or a new repository must create the same ruleset before it merges this workflow.

## Owner steps

These change repository or package settings. Nobody else does them.

| When | Step |
|---|---|
| Once, before this workflow reaches `main` | The **tag ruleset** (above): Settings → Rules → Rulesets → New tag ruleset. Target `refs/tags/v*`. Restrict creations, updates and deletions. Bypass: the admin role only. This repository already has it. |
| Once, before the first tag | Settings → Actions → General: allow GitHub Actions, and under "Workflow permissions" keep the default read-only `GITHUB_TOKEN`. The workflow asks for `packages: write`, `id-token: write` and `contents: write` per job, which a repository workflow may do. If an organisation policy blocks `id-token: write` (OIDC), allow it. |
| First pre-release | Push `v0.4.0-rc.1` (below). |
| After the first push | For each package (server, stick, egress, trooper, and the python, go and jvm presets): Packages → the package → Package settings → **Change visibility → Public**. Check "Repository source" shows this repository: the `org.opencontainers.image.source` label links it. If a package isn't linked, use "Connect repository". |
| Every release after that | Push the version tag. |

## Dry run

Actions → Release → Run workflow, on any branch. `guard`, `build`, `sign` and `publish` are
skipped; `dryrun` runs the same builds (`workflow_dispatch` never logs in to GHCR, signs or
publishes). The images are built exactly as for a release and pushed to a registry that lives only
inside the job, so the presets still build `FROM` the trooper by digest. `dryrun` holds only
`packages: read`, so even a modified branch's dry run cannot push to GHCR. Expected: `dryrun`'s
`troopers` and `apps` green, nothing on GHCR.

## Cutting a release

First, check nothing was released behind your back. Both must show only what you created:

```sh
git ls-remote --tags origin 'v*'
gh api "/users/x-a-n-d-e-r-k/packages?package_type=container" --jq '.[].name'
```

The first release must find no `v*` tag and no `jumpmaster-*` package at all. If either shows a
tag or package you didn't create, stop and treat the signing identity as burned: a signature made
from it cannot be withdrawn, and every stick trusting it would run whatever was signed. Rotate the
identity ("If the workflow path or the repository moves", below: rename the workflow file and
release a stick that trusts only the new one), find out who held tag or admin rights, and delete
the stray tag and packages.

Then, from a clean checkout of `main` that includes the commit you want:

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
4. Each image index lists both `linux/amd64` and `linux/arm64`:
   `docker buildx imagetools inspect ghcr.io/x-a-n-d-e-r-k/jumpmaster-stick@sha256:<digest>`.
5. Once, as a negative rehearsal: create an rc tag on a commit that is not on `main` (a scratch
   branch), push it, and confirm `guard` fails and nothing is built. Then delete the tag
   (`git push origin :refs/tags/<tag>`, which the ruleset lets only an admin do).

### After the first tag: the stick rehearsals

These need a published, signed release, so they wait for `v0.4.0-rc.1`. Run them with the release's
stick image on a test host, against a zone with `requireSignedImages: true`, and record the stick
log lines in the release notes:

1. A released preset runs: the stick logs `image-verified` with `"via":"cosign"` for the trooper
   (a released preset from `images.lock.json`) and the proxy, the drop completes, and
   `/state/verified.json` now lists their digests.
2. An unsigned local image is refused (`image not verified: …: no signatures found`) and is never
   pulled; pinned by digest in `JM_ALLOWED_IMAGES` it runs (`"via":"pinned"`).
3. With a cold cache and Sigstore unreachable: stop the stick, delete `/state/verified.json`, block
   `tuf-repo-cdn.sigstore.dev`, `rekor.sigstore.dev` and `fulcio.sigstore.dev` from the stick (a
   host firewall rule, or an unreachable `HTTPS_PROXY` for the stick), start it, run a drop: it
   fails with `image not verified`, nothing is created.
4. With a warm cache and Sigstore unreachable: same block, but keep the `verified.json` from step 1: the same
   drop runs (`"via":"cache"`).
5. Repeat step 1 on an arm64 host (Apple silicon) and an amd64 host.

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

## What a stick needs to verify images

The stick image runs the `signed` image policy (`JM_IMAGE_POLICY=signed`). Before it creates any
container for a drop it verifies the trooper, the egress proxy and every service image, then
pulls each by digest: a digest the operator pinned in `JM_ALLOWED_IMAGES` passes as it is, and
anything else must carry a cosign signature with the identity above, checked against the
registry, so an unsigned image is never downloaded. A tag never runs. A pin is a name and a
digest: `ghcr.io/o/x:v1@sha256:…` and `ghcr.io/o/x@sha256:…` are the same pin, but the same
digest under another name is not (the refusal says so). A
verified digest is cached for 7 days in `/state/verified.json` (root-only, `0600`; a file that
doesn't parse or has another owner or mode is ignored), so a short Sigstore outage doesn't stop
images it already verified. Each image is logged once per drop as
`{"event":"image-verified","ref":…,"via":"cosign"|"pinned"|"cache"}`.

At startup under `signed` the stick refuses to run, with the reason, when:

- its cosign isn't the pinned version (the image ships it; nothing to install);
- a `JM_ALLOWED_IMAGES`, `JM_TROOPER_IMAGE` or `JM_EGRESS_IMAGE` value is not a digest
  reference (`name@sha256:<64 hex>`);
- `SIGSTORE_*`, `COSIGN_*` or `TUF_MIRROR` is set (they would change what cosign trusts; cosign
  gets only `PATH`, `HOME`, `TMPDIR`, `TUF_ROOT`, the CA-store variables and proxy variables);
- it has no trusted signer (an image built without `RELEASE_REPOSITORY`). A fork sets
  `JM_TRUSTED_SIGNER_REPOSITORY=<owner/name>` to trust its own release workflow; the stick logs
  the override at start.

Only then does it advertise `image-verify-v1`, which the server requires before it leases a drop
from a zone with `requireSignedImages`. To run unsigned local images instead, set
`JM_IMAGE_POLICY=allowlist` (M3's behaviour: `JM_ALLOWED_IMAGES` names each image exactly, tags
allowed); such a stick never gets a signed zone's drops.

The stick's own outbound traffic (not restricted by Jumpmaster; allow it if the host filters):

- `ghcr.io` and `pkg-containers.githubusercontent.com`: image pulls;
- `tuf-repo-cdn.sigstore.dev`: the Sigstore trust root (kept under `/state/sigstore`);
- `rekor.sigstore.dev` and `fulcio.sigstore.dev`: the transparency log and the CA;
- the Jumpmaster server.

The egress capability check (`egress-v1`) runs short-lived probe containers on the host network,
from the stick's own image, as `nobody`, with no capabilities, to prove a drop can't reach the
host. Under `signed`, the proxy image it starts is first verified and then pulled by digest, so the
release stick image carries its release's proxy digest in `JM_EGRESS_IMAGE`.

### Moving an existing zone onto the stick image

A zone that runs a locally built trooper (an image with a tag, such as one built `FROM` the
trooper for a project's toolchain) does not run on the stick image as it is: the signed policy
refuses tags. Either push that image to a registry and pin its digest in `JM_ALLOWED_IMAGES`
(and use the same digest reference as the zone's `image`), build it `FROM` a released preset and
pin it the same way, or keep that zone's stick on `JM_IMAGE_POLICY=allowlist` and leave the zone's
`requireSignedImages` unset. A service image (a database, say) is not signed by this workflow:
pin it by digest.
